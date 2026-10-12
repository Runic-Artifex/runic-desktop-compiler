//! Pinned image URLs (M6, docs/design/M6-IMAGES.md). `runic images <app>`
//! fetched each URL the program can load once; the generated app embeds the
//! bytes, or the HTTP status of a pinned failure, in `App::IMAGES`. The
//! document's net provider ([`PinnedNetProvider`]) serves image requests from
//! the table and never opens a socket.

use blitz_shell::DataUriNetProvider;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request, Url};

/// The document's base URL. Blitz resolves an `<img>`'s `src` against it, so
/// a root-relative URL (`/logo.png`, a file of the app's static directory)
/// resolves as against a page's origin in a browser, and an absolute URL to
/// itself (normalised by the URL parser). The `.invalid` top-level domain
/// names no host, so no pinned remote URL can collide with a root-relative
/// one.
pub(crate) const BASE_URL: &str = "http://runic.invalid/";

/// One pinned URL: the image's MIME type and bytes, or the HTTP status its
/// fetch ended with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PinnedImage {
    pub url: &'static str,
    pub image: Result<(&'static str, &'static [u8]), u16>,
}

/// The entry for `url` in `table` (sorted by URL, as codegen emits it).
pub fn find(table: &'static [PinnedImage], url: &str) -> Option<&'static PinnedImage> {
    table
        .binary_search_by(|entry| entry.url.cmp(url))
        .ok()
        .map(|i| &table[i])
}

/// The document's net provider: `data:` URLs (the stylesheet's fonts) are
/// decoded as before; any other URL is looked up in the pinned table under
/// the URL Blitz requests (the entry's URL resolved against [`BASE_URL`]).
/// A pinned image completes the request with its bytes, a pinned failure
/// with an error (Blitz then fires `error`). A URL the table lacks cannot
/// occur in a program the compiler accepted: it is reported as unsupported,
/// and the request never completes (no event, no socket).
pub(crate) struct PinnedNetProvider {
    /// `(resolved URL, entry)`, sorted by the resolved URL.
    images: Vec<(String, &'static PinnedImage)>,
    data: DataUriNetProvider,
}

impl PinnedNetProvider {
    pub(crate) fn new(table: &'static [PinnedImage]) -> Self {
        let base = Url::parse(BASE_URL).expect("base URL");
        let mut images: Vec<(String, &'static PinnedImage)> = table
            .iter()
            .filter_map(|entry| Some((base.join(entry.url).ok()?.to_string(), entry)))
            .collect();
        images.sort_by(|a, b| a.0.cmp(&b.0));
        Self {
            images,
            data: DataUriNetProvider::new(None),
        }
    }

    /// The entry a request for `url` (resolved against the base) loads.
    fn lookup(&self, url: &str) -> Option<&'static PinnedImage> {
        self.images
            .binary_search_by(|(resolved, _)| resolved.as_str().cmp(url))
            .ok()
            .map(|i| self.images[i].1)
    }
}

/// What an image object's `src` reads (M6, `new Image()`): the value
/// resolved against the document's base URL (Chromium resolves it against
/// the page's URL: a root-relative or empty value reads with the page's
/// origin, here `http://runic.invalid`); a value that does not parse reads
/// as written.
pub fn resolve(src: &str) -> String {
    let base = Url::parse(BASE_URL).expect("base URL");
    base.join(src)
        .map_or_else(|_| src.to_owned(), |u| u.to_string())
}

thread_local! {
    /// Whether each pinned image's bytes decode, by URL (decoded once).
    static DECODED: std::cell::RefCell<std::collections::HashMap<&'static str, bool>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// The outcome of an image object's request for `src` (M6, `new Image()`):
/// `Some(true)` fires `load`, `Some(false)` fires `error`. A pinned image
/// loads when its bytes decode (with the decoders Blitz uses for `<img>`),
/// a pinned failure and an empty `src` give `error`. A URL the table lacks
/// cannot occur in a program the compiler accepted: it is reported as
/// unsupported (`None`, no event), as are SVG images, which the runtime
/// decodes only for `<img>`.
pub fn outcome(table: &'static [PinnedImage], src: &str) -> Option<bool> {
    if src.is_empty() {
        return Some(false);
    }
    let base = Url::parse(BASE_URL).expect("base URL");
    let wanted = base.join(src).ok().map(|u| u.to_string());
    let entry = wanted.as_deref().and_then(|wanted| {
        table
            .iter()
            .find(|e| base.join(e.url).is_ok_and(|u| u.as_str() == wanted))
    });
    let Some(entry) = entry else {
        crate::unsupported(&format!(
            "E_ASSET: image URL {src} is not pinned: the compiler found no such src value (an image object's request outside the table never loads)"
        ));
        return None;
    };
    match entry.image {
        Err(_) => Some(false),
        Ok(("image/svg+xml", _)) => {
            crate::unsupported(&format!(
                "an image object loading the SVG image {src} (SVG images are decoded for <img> only)"
            ));
            None
        }
        Ok((_, bytes)) => Some(DECODED.with(|d| {
            *d.borrow_mut().entry(entry.url).or_insert_with(|| {
                image::ImageReader::new(std::io::Cursor::new(bytes))
                    .with_guessed_format()
                    .is_ok_and(|r| r.decode().is_ok())
            })
        })),
    }
}

/// `url` as the program wrote it: root-relative for the app's own files.
fn shown(url: &str) -> &str {
    url.strip_prefix(BASE_URL.trim_end_matches('/'))
        .unwrap_or(url)
}

impl NetProvider for PinnedNetProvider {
    fn fetch(&self, doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        if request.url.scheme() == "data" {
            return self.data.fetch(doc_id, request, handler);
        }
        let url = request.url.to_string();
        match self.lookup(&url).map(|entry| entry.image) {
            Some(Ok((_, bytes))) => handler.bytes(url, Bytes::from_static(bytes)),
            Some(Err(status)) => handler.error(url, format!("pinned HTTP status {status}")),
            None => crate::unsupported(&format!(
                "E_ASSET: image URL {} is not pinned: the compiler found no such src value (a request outside the table never loads)",
                shown(&url)
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    static TABLE: [PinnedImage; 3] = [
        PinnedImage {
            url: "/logo.png",
            image: Ok(("image/png", b"\x89PNG")),
        },
        PinnedImage {
            url: "https://a.example/avatar.jpg",
            image: Ok(("image/jpeg", b"\xff\xd8\xff")),
        },
        PinnedImage {
            url: "https://b.example/missing.png",
            image: Err(404),
        },
    ];

    #[test]
    fn finds_pinned_urls_exactly() {
        assert_eq!(
            find(&TABLE, "https://a.example/avatar.jpg").map(|e| e.image),
            Some(Ok(("image/jpeg", &b"\xff\xd8\xff"[..])))
        );
        assert_eq!(
            find(&TABLE, "https://b.example/missing.png").map(|e| e.image),
            Some(Err(404))
        );
        assert_eq!(find(&TABLE, "/logo.png").map(|e| e.url), Some("/logo.png"));
        assert!(find(&TABLE, "https://a.example/avatar.JPG").is_none());
        assert!(find(&[], "/logo.png").is_none());
    }

    /// The handler's completion: `Ok(bytes)` or `Err(message)`.
    type Outcome = Arc<Mutex<Option<Result<Vec<u8>, String>>>>;

    struct Recorder(Outcome);
    impl NetHandler for Recorder {
        fn bytes(self: Box<Self>, _url: String, bytes: Bytes) {
            *self.0.lock().unwrap() = Some(Ok(bytes.to_vec()));
        }
        fn error(self: Box<Self>, _url: String, message: String) {
            *self.0.lock().unwrap() = Some(Err(message));
        }
    }

    /// Fetch `src` as Blitz requests it: resolved against the base URL.
    fn fetch(src: &str) -> Option<Result<Vec<u8>, String>> {
        let outcome = Outcome::default();
        let url = Url::parse(BASE_URL).unwrap().join(src).unwrap();
        PinnedNetProvider::new(&TABLE).fetch(
            0,
            Request::get(url),
            Box::new(Recorder(outcome.clone())),
        );
        outcome.lock().unwrap().take()
    }

    #[test]
    fn serves_pinned_urls_as_blitz_requests_them() {
        assert_eq!(fetch("/logo.png"), Some(Ok(b"\x89PNG".to_vec())));
        // The parser normalises the host's case and the default port.
        assert_eq!(
            fetch("HTTPS://A.example:443/avatar.jpg"),
            Some(Ok(b"\xff\xd8\xff".to_vec()))
        );
        assert!(matches!(
            fetch("https://b.example/missing.png"),
            Some(Err(m)) if m.contains("404")
        ));
        assert_eq!(fetch("data:text/plain,abc"), Some(Ok(b"abc".to_vec())));
        assert_eq!(resolve(""), BASE_URL);
        assert_eq!(resolve("/x.png"), "http://runic.invalid/x.png");
        assert_eq!(resolve("HTTPS://A.example:443/x"), "https://a.example/x");
    }

    #[test]
    fn image_objects_load_decoded_pinned_images() {
        // A 2x1 PNG, encoded by the decoder's own crate.
        let mut png = Vec::new();
        image::RgbaImage::new(2, 1)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let png: &'static [u8] = Box::leak(png.into_boxed_slice());
        let table: &'static [PinnedImage] = Box::leak(Box::new([
            PinnedImage {
                url: "/bad.png",
                image: Ok(("image/png", b"\x89PNG")),
            },
            PinnedImage {
                url: "/good.png",
                image: Ok(("image/png", png)),
            },
            PinnedImage {
                url: "https://b.example/missing.png",
                image: Err(404),
            },
        ]));
        assert_eq!(outcome(table, "/good.png"), Some(true));
        assert_eq!(outcome(table, "http://runic.invalid/good.png"), Some(true));
        // Bytes that do not decode, a pinned failure and an empty source fail.
        assert_eq!(outcome(table, "/bad.png"), Some(false));
        assert_eq!(outcome(table, "HTTPS://B.example/missing.png"), Some(false));
        assert_eq!(outcome(table, ""), Some(false));
        assert_eq!(shown("http://runic.invalid/x.png"), "/x.png");
        assert_eq!(shown("https://c.example/x.png"), "https://c.example/x.png");
    }
}
