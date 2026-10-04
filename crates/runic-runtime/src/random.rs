//! `Math.random()` and `crypto.randomUUID()` (docs/design/M5-PLATFORM.md,
//! host services). Apps use OS randomness: `Math.random` is a generator
//! seeded from the OS once per app (as V8 seeds its own), and every UUID
//! takes 16 bytes from the OS. Probes use the shared seeded generator
//! (`runic_js::random`, seed from the case), restarted with each app
//! instance as the browser harness restarts it with each page load.

use runic_js::JsString;
use runic_js::random::{SplitMix64, uuid};
use std::cell::Cell;

thread_local! {
    /// The probe's seed.
    static SEED: Cell<Option<u64>> = const { Cell::new(None) };
}

/// Use the seeded generator (probes).
#[cfg(feature = "probe")]
pub(crate) fn seed(seed: u64) {
    SEED.with(|s| s.set(Some(seed)));
}

pub struct Random {
    generator: SplitMix64,
    /// UUIDs come from the generator (probes) instead of the OS.
    seeded: bool,
}

fn os_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS randomness");
    b
}

impl Random {
    pub fn new() -> Self {
        match SEED.with(Cell::get) {
            Some(seed) => Random {
                generator: SplitMix64::new(seed),
                seeded: true,
            },
            None => Random {
                generator: SplitMix64::new(u64::from_le_bytes(os_bytes())),
                seeded: false,
            },
        }
    }

    pub fn number(&mut self) -> f64 {
        self.generator.number()
    }

    pub fn uuid(&mut self) -> JsString {
        JsString::from(if self.seeded {
            self.generator.uuid()
        } else {
            uuid(os_bytes())
        })
    }
}

impl Default for Random {
    fn default() -> Self {
        Random::new()
    }
}
