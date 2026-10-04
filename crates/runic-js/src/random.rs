//! The seeded generator behind `Math.random()` and `crypto.randomUUID()` in
//! probes and the reference interpreter (docs/design/M5-PLATFORM.md, host
//! services). Chromium cannot be seeded, so the browser harness replaces
//! both functions with this generator (conformance/harness/browser.mjs);
//! production uses OS randomness (runic-runtime).
//!
//! SplitMix64: a number is the top 53 bits of the next output over 2^53; a
//! UUID takes 16 bytes from two outputs (big-endian) with the version 4 and
//! variant bits set, in lowercase hexadecimal.

#[derive(Clone, Debug)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        SplitMix64 { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in [0, 1).
    pub fn number(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Sixteen bytes.
    pub fn bytes(&mut self) -> [u8; 16] {
        let mut b = [0u8; 16];
        b[..8].copy_from_slice(&self.next_u64().to_be_bytes());
        b[8..].copy_from_slice(&self.next_u64().to_be_bytes());
        b
    }

    pub fn uuid(&mut self) -> String {
        uuid(self.bytes())
    }
}

/// A version 4 UUID from 16 random bytes (`crypto.randomUUID()`'s format).
pub fn uuid(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix64_reference_outputs() {
        // The reference SplitMix64 sequence for seed 0.
        let mut g = SplitMix64::new(0);
        assert_eq!(g.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(g.next_u64(), 0x6E78_9E6A_A1B9_65F4);
        let mut g = SplitMix64::new(1);
        let x = g.number();
        assert!((0.0..1.0).contains(&x));
        let id = g.uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }
}
