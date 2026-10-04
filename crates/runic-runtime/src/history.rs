//! Session history and location (docs/design/M5-PLATFORM.md, host
//! services): an in-process history (`runic_js::history`, shared with the
//! reference interpreter) starting at the app's start URL, `/`, or the
//! case's `url` in probes. It outlives app instances (a probe `reload`
//! starts a new document at the current entry).

use runic_js::history::{Session, Traversal};
use runic_js::{JsResult, JsString};
use std::cell::RefCell;

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    /// The probe's start URL.
    static START: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Start probes at `url` (a path with optional query and fragment).
#[cfg(feature = "probe")]
pub(crate) fn seed(url: String) {
    START.with(|s| *s.borrow_mut() = Some(url));
}

fn with<R>(f: impl FnOnce(&mut Session) -> R) -> R {
    SESSION.with(|s| {
        let mut s = s.borrow_mut();
        let session = s.get_or_insert_with(|| {
            let start = START
                .with(|u| u.borrow().clone())
                .unwrap_or_else(|| "/".into());
            Session::new(&start).unwrap_or_else(|e| panic!("{e}"))
        });
        f(session)
    })
}

/// A document starts loading (the app is created): the first one at the
/// start URL, later ones (reloads) at the current entry.
pub(crate) fn begin_document() {
    let fresh = SESSION.with(|s| s.borrow().is_none());
    with(|s| {
        if !fresh {
            s.start_document();
        }
    });
}

/// The document has loaded (the app is mounted).
pub(crate) fn loaded() {
    with(Session::loaded);
}

pub fn push(url: Option<&JsString>) -> JsResult<()> {
    with(|s| s.push(url))
}

pub fn replace(url: Option<&JsString>) -> JsResult<()> {
    with(|s| s.replace(url))
}

/// `location.hash = value`; whether it navigated (`popstate` fires at once,
/// then `hashchange` as a task).
pub fn set_hash(value: &JsString) -> JsResult<bool> {
    with(|s| s.set_hash(value))
}

pub fn traverse(delta: i64) -> JsResult<Option<Traversal>> {
    with(|s| s.traverse(delta))
}

pub fn length() -> f64 {
    with(|s| s.length() as f64)
}

pub fn pathname() -> JsString {
    JsString::from(with(|s| s.pathname()))
}

pub fn search() -> JsString {
    JsString::from(with(|s| s.search()))
}

pub fn hash() -> JsString {
    JsString::from(with(|s| s.hash()))
}

/// `location.href` without the origin, and `history.length` (probe snapshots).
#[cfg(feature = "probe")]
pub(crate) fn state() -> (String, usize) {
    with(|s| (s.href(), s.length()))
}
