//! Session history and the location of one browsing context
//! (docs/design/M5-PLATFORM.md, host services), as Chromium keeps them for
//! same-document navigations: `history.pushState`/`replaceState` (no
//! events), fragment navigations through `location.hash` (a new entry, or a
//! replaced one while the document loads), and traversals (`back`,
//! `forward`, `go`) between entries. URLs are parsed with the WHATWG URL
//! standard (`url`), pinned against Chromium by `tests/vectors/history.json`.
//!
//! The origin is not modelled: every location is relative to it, and URLs
//! naming another origin (or any absolute URL) are unsupported.

use crate::{JsString, Throw};
use url::{Position, Url};

/// The stand-in origin of relative locations (never observable).
const BASE: &str = "http://runic.invalid/";

/// Chromium's session history limit: older entries are dropped.
pub const MAX_ENTRIES: usize = 50;

#[derive(Clone, Debug)]
struct Entry {
    url: Url,
    /// The document the entry belongs to (a reload starts a new one).
    document: u32,
}

/// A traversal that changed the current entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Traversal {
    /// The URLs differ only in their fragments: `hashchange` follows `popstate`.
    pub hashchange: bool,
}

#[derive(Clone, Debug)]
pub struct Session {
    entries: Vec<Entry>,
    index: usize,
    document: u32,
    /// The document is loading (the app mounts): fragment navigations
    /// replace the current entry, as in Chromium before the load event.
    loading: bool,
    /// Fragment navigations made while loading.
    loading_navigations: u32,
}

/// The error of unsupported history operations (a runtime shape the model
/// does not cover, like `RunicKeyError` for duplicate keys).
fn unsupported(message: &str) -> Throw {
    Throw::new("RunicHistoryError", message)
}

impl Session {
    /// A session with one entry at `start` (a path with optional query and
    /// fragment, such as `/` or `/items?q=1#/x`), loading.
    pub fn new(start: &str) -> Result<Session, String> {
        let url = Url::parse(BASE)
            .and_then(|b| b.join(start))
            .map_err(|e| format!("invalid start URL {start:?}: {e}"))?;
        if url.origin() != Url::parse(BASE).expect("base").origin() {
            return Err(format!("the start URL {start:?} must be a path"));
        }
        Ok(Session {
            entries: vec![Entry { url, document: 0 }],
            index: 0,
            document: 0,
            loading: true,
            loading_navigations: 0,
        })
    }

    fn url(&self) -> &Url {
        &self.entries[self.index].url
    }

    /// `location.pathname`.
    pub fn pathname(&self) -> String {
        self.url().path().to_owned()
    }

    /// `location.search`: `?` and the query, or empty for an empty query.
    pub fn search(&self) -> String {
        match self.url().query() {
            Some(q) if !q.is_empty() => format!("?{q}"),
            _ => String::new(),
        }
    }

    /// `location.hash`: `#` and the fragment, or empty for an empty fragment.
    pub fn hash(&self) -> String {
        match self.url().fragment() {
            Some(f) if !f.is_empty() => format!("#{f}"),
            _ => String::new(),
        }
    }

    /// `location.href` without the origin.
    pub fn href(&self) -> String {
        self.url()[Position::BeforePath..].to_owned()
    }

    /// `history.length`.
    pub fn length(&self) -> usize {
        self.entries.len()
    }

    /// The URL `input` names relative to the current one (`pushState`'s
    /// third argument). Absolute URLs and other origins are unsupported:
    /// Chromium throws a SecurityError naming the page's origin.
    fn resolve(&self, input: &JsString) -> Result<Url, Throw> {
        let text = input.to_rust();
        let cross = || {
            unsupported(&format!(
                "history URL {text:?} names another origin or is absolute (Chromium throws a SecurityError naming the origin)"
            ))
        };
        if Url::parse(&text).is_ok() {
            return Err(cross());
        }
        // A lone surrogate in the path makes Chromium's URL invalid (a
        // SecurityError); in the query and fragment it becomes U+FFFD.
        let units = input.units();
        let path_end = units
            .iter()
            .position(|&u| u == u16::from(b'?') || u == u16::from(b'#'))
            .unwrap_or(units.len());
        if String::from_utf16(&units[..path_end]).is_err() {
            return Err(unsupported(
                "a lone surrogate in a history URL's path (Chromium throws a SecurityError)",
            ));
        }
        // Chromium completes an empty URL to the document's URL, fragment included.
        if text.is_empty() {
            return Ok(self.url().clone());
        }
        let mut url = self.url().join(&text).map_err(|_| cross())?;
        if url.origin() != self.url().origin() {
            return Err(cross());
        }
        // Chromium also escapes `^` and `|` in paths.
        if url.path().contains(['^', '|']) {
            let path = url.path().replace('^', "%5E").replace('|', "%7C");
            url.set_path(&path);
        }
        Ok(url)
    }

    /// Append an entry after the current one, dropping later entries (and
    /// the oldest beyond the limit).
    fn append(&mut self, url: Url) {
        self.entries.truncate(self.index + 1);
        self.entries.push(Entry {
            url,
            document: self.document,
        });
        if self.entries.len() > MAX_ENTRIES {
            self.entries.remove(0);
        }
        self.index = self.entries.len() - 1;
    }

    /// `history.pushState(null, "", url)`: a new entry, no events.
    pub fn push(&mut self, url: Option<&JsString>) -> Result<(), Throw> {
        let url = match url {
            Some(u) => self.resolve(u)?,
            None => self.url().clone(),
        };
        self.append(url);
        Ok(())
    }

    /// `history.replaceState(null, "", url)`: the current entry's URL, no events.
    pub fn replace(&mut self, url: Option<&JsString>) -> Result<(), Throw> {
        if let Some(u) = url {
            let url = self.resolve(u)?;
            self.entries[self.index].url = url;
        }
        Ok(())
    }

    /// `location.hash = value`: a fragment navigation unless the fragment is
    /// already `value` (one leading `#` removed). Returns whether it
    /// navigated: `popstate` fires at once (nested in the setter), then
    /// `hashchange` as a task. While the document loads the entry is
    /// replaced; Chromium delays the `hashchange` of such navigations past
    /// the load event, in an order the model covers for one navigation only.
    pub fn set_hash(&mut self, value: &JsString) -> Result<bool, Throw> {
        let units = value.units();
        let input = match units.first() {
            Some(&u) if u == u16::from(b'#') => &units[1..],
            _ => units,
        };
        let mut url = self.url().clone();
        url.set_fragment(Some(&String::from_utf16_lossy(input)));
        // An absent fragment counts as empty here (Chromium: setting "" on
        // a URL without a fragment does nothing).
        if url.fragment() == Some(self.url().fragment().unwrap_or("")) {
            return Ok(false);
        }
        if self.loading {
            if self.loading_navigations > 0 {
                return Err(unsupported(
                    "a second location.hash navigation while the document loads (Chromium delays their hashchange events past the load event in an unmodelled order)",
                ));
            }
            self.loading_navigations += 1;
            self.entries[self.index].url = url;
        } else {
            self.append(url);
        }
        Ok(true)
    }

    /// Following a link to `href` (`<a href="#name">`): a fragment
    /// navigation of this document, as the HTML standard's "navigate"
    /// makes it from a link. It pushes an entry, or replaces the current one
    /// when the URL is the current URL (following the same link again);
    /// `popstate` fires either way, then `hashchange` as a task when the
    /// fragment changed (the result). Links to other documents are
    /// unsupported (the compiler only accepts fragment links).
    pub fn follow_fragment(&mut self, href: &JsString) -> Result<bool, Throw> {
        let text = href.to_rust();
        if !text.starts_with('#') {
            return Err(unsupported(&format!(
                "following a link to {text:?}, which is not a fragment of this document"
            )));
        }
        let url = self
            .url()
            .join(&text)
            .map_err(|_| unsupported(&format!("the link {text:?} does not parse")))?;
        let hashchange = url.fragment() != self.url().fragment();
        if &url == self.url() || self.loading {
            self.entries[self.index].url = url;
        } else {
            self.append(url);
        }
        Ok(hashchange)
    }

    /// Traverse by `delta` entries (`history.go(delta)`, back and forward).
    /// Out of range does nothing. Traversals to entries of an earlier
    /// document (before a reload) load that document in Chromium, which the
    /// model does not cover.
    pub fn traverse(&mut self, delta: i64) -> Result<Option<Traversal>, Throw> {
        let target = self.index as i64 + delta;
        if delta == 0 || target < 0 || target >= self.entries.len() as i64 {
            return Ok(None);
        }
        let target = target as usize;
        if self.entries[target].document != self.document {
            return Err(unsupported(
                "a traversal to an entry of an earlier document (before a reload)",
            ));
        }
        let old = self.url().clone();
        self.index = target;
        let new = self.url();
        let hashchange = old[..Position::AfterQuery] == new[..Position::AfterQuery]
            && old.fragment() != new.fragment();
        Ok(Some(Traversal { hashchange }))
    }

    /// A new document at the current entry (a reload), loading.
    pub fn start_document(&mut self) {
        self.document += 1;
        self.entries[self.index].document = self.document;
        self.loading = true;
        self.loading_navigations = 0;
    }

    /// The document finished loading (the app is mounted).
    pub fn loaded(&mut self) {
        self.loading = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> JsString {
        JsString::from(x)
    }

    #[test]
    fn push_replace_traverse() {
        let mut h = Session::new("/start?q=1#a").unwrap();
        h.loaded();
        assert_eq!(
            (h.pathname(), h.search(), h.hash()),
            ("/start".into(), "?q=1".into(), "#a".into())
        );
        h.push(Some(&s("/b"))).unwrap();
        h.push(Some(&s("#c"))).unwrap();
        assert_eq!(h.length(), 3);
        assert_eq!(h.href(), "/b#c");
        // Fragment-only difference: hashchange follows popstate.
        assert_eq!(
            h.traverse(-1).unwrap(),
            Some(Traversal { hashchange: true })
        );
        assert_eq!(
            h.traverse(-1).unwrap(),
            Some(Traversal { hashchange: false })
        );
        assert_eq!(h.traverse(-1).unwrap(), None);
        assert_eq!(h.traverse(5).unwrap(), None);
        h.replace(Some(&s("/r"))).unwrap();
        assert_eq!(h.href(), "/r");
        assert!(h.push(Some(&s("http://example.com/"))).is_err());
        assert!(h.push(Some(&s("//host/x"))).is_err());
    }

    #[test]
    fn hash_navigation_and_limit() {
        let mut h = Session::new("/").unwrap();
        // While loading, a fragment navigation replaces the entry.
        assert!(h.set_hash(&s("#/home")).unwrap());
        assert_eq!(h.length(), 1);
        assert!(h.set_hash(&s("#/other")).is_err());
        h.loaded();
        assert!(!h.set_hash(&s("/home")).unwrap());
        assert!(h.set_hash(&s("")).unwrap());
        assert_eq!(
            (h.hash(), h.href(), h.length()),
            (String::new(), "/#".into(), 2)
        );
        for i in 0..60 {
            h.push(Some(&s(&format!("/p{i}")))).unwrap();
        }
        assert_eq!(h.length(), MAX_ENTRIES);
        assert_eq!(h.href(), "/p59");
    }

    #[test]
    fn following_fragment_links() {
        let mut h = Session::new("/start?q=1").unwrap();
        h.loaded();
        // A new fragment pushes an entry (hashchange follows popstate).
        assert!(h.follow_fragment(&s("#login")).unwrap());
        assert_eq!((h.href(), h.length()), ("/start?q=1#login".into(), 2));
        // The same link again replaces the entry (popstate only).
        assert!(!h.follow_fragment(&s("#login")).unwrap());
        assert_eq!(h.length(), 2);
        assert!(h.follow_fragment(&s("#a%20b")).unwrap());
        assert_eq!((h.hash(), h.length()), ("#a%20b".into(), 3));
        assert_eq!(
            h.traverse(-1).unwrap(),
            Some(Traversal { hashchange: true })
        );
        // Links to other documents are not fragment navigations.
        assert!(h.follow_fragment(&s("/other")).is_err());
        assert!(h.follow_fragment(&s("?q=2")).is_err());
    }

    #[test]
    fn reload_starts_a_document() {
        let mut h = Session::new("/").unwrap();
        h.loaded();
        h.push(Some(&s("/a"))).unwrap();
        h.start_document();
        h.loaded();
        assert!(h.traverse(-1).is_err());
        h.push(Some(&s("/b"))).unwrap();
        assert_eq!(
            h.traverse(-1).unwrap(),
            Some(Traversal { hashchange: false })
        );
    }
}
