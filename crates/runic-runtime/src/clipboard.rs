//! `navigator.clipboard.writeText/readText` (docs/design/M5-PLATFORM.md,
//! host services). Apps use the OS clipboard (arboard: X11, or Wayland
//! through the data-control protocol, falling back to XWayland); probes keep
//! the text in memory, seeded by the case (`--clipboard`). The generated app
//! settles the promise in a task after the one that asked (as Chromium,
//! whose clipboard replies arrive from the browser process).
//!
//! A clipboard holds text: lone surrogates become U+FFFD, as in Chromium.

use runic_js::JsString;
use std::cell::RefCell;

thread_local! {
    /// The probe's clipboard (`Some` in probe mode).
    static MEMORY: RefCell<Option<JsString>> = const { RefCell::new(None) };
    /// The OS clipboard, opened on first use and kept for the app's life
    /// (on X11 the app serves its selection while it owns it).
    static OS: RefCell<Option<arboard::Clipboard>> = const { RefCell::new(None) };
}

/// Keep the clipboard in memory, starting with `text` (probes).
#[cfg(feature = "probe")]
pub(crate) fn seed(text: JsString) {
    MEMORY.with(|m| *m.borrow_mut() = Some(JsString::from(text.to_rust())));
}

/// The probe's clipboard text.
#[cfg(feature = "probe")]
pub(crate) fn text() -> Option<JsString> {
    MEMORY.with(|m| m.borrow().clone())
}

fn os<R>(
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<R, arboard::Error>,
) -> Result<R, String> {
    OS.with(|c| {
        let mut c = c.borrow_mut();
        if c.is_none() {
            *c = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        f(c.as_mut().expect("clipboard")).map_err(|e| e.to_string())
    })
}

/// Write `text`; the error message rejects the promise (`NotAllowedError`).
pub fn write(text: &JsString) -> Result<(), String> {
    let text = text.to_rust();
    if let Some(()) = MEMORY.with(|m| {
        m.borrow_mut()
            .as_mut()
            .map(|m| *m = JsString::from(text.as_str()))
    }) {
        return Ok(());
    }
    os(|c| c.set_text(text))
}

/// Read the text (empty when the clipboard holds none, as in Chromium).
pub fn read() -> Result<JsString, String> {
    if let Some(t) = MEMORY.with(|m| m.borrow().clone()) {
        return Ok(t);
    }
    match os(|c| match c.get_text() {
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        other => other,
    }) {
        Ok(t) => Ok(JsString::from(t)),
        Err(e) => Err(e),
    }
}
