//! `console.log/info/warn/error/debug` (docs/design/M5-PLATFORM.md, host
//! services). A line is the arguments' ToString joined with spaces, as
//! Chromium's console message text (and Playwright's `msg.text()`). Apps
//! write it to stderr; probes keep it for their next snapshot.

use runic_js::JsString;
use std::cell::RefCell;

thread_local! {
    /// Probe lines since the last snapshot: (level, text).
    static LINES: RefCell<Vec<(&'static str, JsString)>> = const { RefCell::new(Vec::new()) };
}

/// Write a console line of `level` (`log`, `info`, `warn`, `error`, `debug`).
pub fn write(level: &'static str, args: &[JsString]) {
    let mut text: Vec<u16> = vec![];
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            text.push(u16::from(b' '));
        }
        text.extend_from_slice(a.units());
    }
    let text = JsString::from_units(text);
    if crate::probe_mode() {
        LINES.with(|l| l.borrow_mut().push((level, text)));
    } else {
        eprintln!("{text}");
    }
}

/// The probe's lines since the last call.
#[cfg(feature = "probe")]
pub(crate) fn take() -> Vec<(&'static str, JsString)> {
    LINES.with(|l| std::mem::take(&mut *l.borrow_mut()))
}
