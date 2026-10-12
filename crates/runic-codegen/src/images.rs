//! Pinned images (M6, docs/design/M6-IMAGES.md): the bytes of each image
//! asset come from the app's directory (the IR records only their path,
//! SHA-256, size and MIME type), are checked against the IR and are copied
//! into the generated crate as `images/<asset index>`; `table` emits the
//! `IMAGES` table the runtime resolves image URLs through.

use crate::expr::rust_str;
use runic_ir::{Diagnostic, Program, Result};
use std::collections::BTreeSet;
use std::path::Path;

/// The indexes of the assets the `images` table names, in ascending order.
fn image_assets(p: &Program) -> BTreeSet<usize> {
    p.images.iter().filter_map(|i| i.asset).collect()
}

fn asset_error(message: String) -> Diagnostic {
    Diagnostic::new("E_ASSET", message, None)
}

/// Read every image asset of `p` from `root` (the app's directory), check its
/// size and SHA-256 against the IR, and write it to `out/images/<index>`.
/// Programs without image assets need no `root`.
pub fn write(p: &Program, root: Option<&Path>, out: &Path) -> Result<()> {
    let assets = image_assets(p);
    if assets.is_empty() {
        return Ok(());
    }
    let Some(root) = root else {
        return Err(asset_error(
            "The program embeds images: their bytes are read from the app directory (--asset-root)"
                .into(),
        ));
    };
    let dir = out.join("images");
    std::fs::create_dir_all(&dir).map_err(|e| Diagnostic::new("E_OUTPUT", e.to_string(), None))?;
    for index in assets {
        let asset = &p.assets[index];
        let path = root.join(&asset.path);
        let changed = |what: &str| {
            asset_error(format!(
                "Image asset {} {what} since the build pinned it; rebuild (remote images: node compiler/cli.mjs images <app>)",
                asset.path
            ))
        };
        let size = std::fs::metadata(&path)
            .map_err(|e| asset_error(format!("Cannot read image asset {}: {e}", asset.path)))?
            .len();
        if size != asset.bytes {
            return Err(changed("changed size"));
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| asset_error(format!("Cannot read image asset {}: {e}", asset.path)))?;
        if bytes.len() as u64 != asset.bytes {
            return Err(changed("changed size"));
        }
        if sha256_hex(&bytes) != asset.sha256 {
            return Err(changed("changed content"));
        }
        std::fs::write(dir.join(index.to_string()), &bytes)
            .map_err(|e| Diagnostic::new("E_OUTPUT", e.to_string(), None))?;
    }
    Ok(())
}

/// The `IMAGES` constant of the generated `App` (empty for a program without
/// pinned images, which keeps the trait's default). Entries are sorted by URL
/// (byte order) for `runic_runtime::images::find`.
pub fn table(p: &Program) -> String {
    if p.images.is_empty() {
        return String::new();
    }
    let mut images: Vec<_> = p.images.iter().collect();
    images.sort_by(|a, b| a.url.cmp(&b.url));
    let entries: String = images
        .iter()
        .map(|i| {
            let image = match (i.asset, i.status) {
                (Some(a), _) => format!(
                    "Ok(({}, include_bytes!(\"../images/{a}\")))",
                    rust_str(&p.assets[a].mime)
                ),
                (None, Some(status)) => format!("Err({status})"),
                (None, None) => unreachable!("validated image entry"),
            };
            format!(
                "runic_runtime::images::PinnedImage {{ url: {}, image: {image} }}, ",
                rust_str(&i.url)
            )
        })
        .collect();
    format!("const IMAGES: &'static [runic_runtime::images::PinnedImage] = &[{entries}];\n")
}

/// SHA-256 (FIPS 180-4) of `data` as lowercase hex. The workspace has no hash
/// crate; image assets are checked against the collector's digests.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_be_bytes());
    for block in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value as Json, json};

    fn program(assets: Json, images: Json) -> Program {
        serde_json::from_value(json!({
            "schema": 5,
            "meta": {"title": "images", "sourceHash": "0".repeat(64), "frontend": {}},
            "capabilities": ["dom"],
            "styles": {"css": ""},
            "assets": assets,
            "images": images,
            "components": [{"name": "App", "template": []}],
            "root": 0
        }))
        .unwrap()
    }

    /// A fresh directory for one test (removed by the test).
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "runic-codegen-images-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really a png";

    fn png_asset(bytes: &[u8]) -> Json {
        json!({"path": "images/a.png", "sha256": sha256_hex(bytes), "bytes": bytes.len(), "mime": "image/png"})
    }

    #[test]
    fn hashes_like_fips_180_4() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // Several blocks.
        assert_eq!(
            sha256_hex(&[b'a'; 1000]),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        );
    }

    #[test]
    fn copies_checked_image_bytes() {
        let root = scratch("root");
        let out = scratch("out");
        std::fs::create_dir_all(root.join("images")).unwrap();
        std::fs::write(root.join("images/a.png"), PNG).unwrap();
        let font = json!({"path": "assets/f.woff2", "sha256": "f".repeat(64), "bytes": 4, "mime": "font/woff2"});
        let p = program(
            json!([font, png_asset(PNG)]),
            json!([{"url": "https://x/a.png", "asset": 1}]),
        );
        write(&p, Some(&root), &out).unwrap();
        // The font keeps its CSS path; only image assets are copied.
        assert_eq!(std::fs::read(out.join("images/1")).unwrap(), PNG);
        assert!(!out.join("images/0").exists());

        // Altered content of the same size, another size, no file, no root.
        let mut altered = PNG.to_vec();
        altered[9] ^= 1;
        std::fs::write(root.join("images/a.png"), &altered).unwrap();
        let e = write(&p, Some(&root), &out).unwrap_err();
        assert_eq!(e.code, "E_ASSET");
        assert!(e.message.contains("changed content"), "{e}");
        std::fs::write(root.join("images/a.png"), b"\x89PNG").unwrap();
        let e = write(&p, Some(&root), &out).unwrap_err();
        assert!(e.message.contains("changed size"), "{e}");
        std::fs::remove_file(root.join("images/a.png")).unwrap();
        let e = write(&p, Some(&root), &out).unwrap_err();
        assert!(
            e.message.contains("Cannot read image asset images/a.png"),
            "{e}"
        );
        let e = write(&p, None, &out).unwrap_err();
        assert!(e.message.contains("--asset-root"), "{e}");

        // Programs without images need no root and write nothing.
        let empty = scratch("empty");
        write(&program(json!([]), json!([])), None, &empty).unwrap();
        assert!(!empty.join("images").exists());
        for dir in [root, out, empty] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn emits_the_url_table_sorted() {
        assert_eq!(table(&program(json!([]), json!([]))), "");
        let p = program(
            json!([png_asset(PNG)]),
            json!([
                {"url": "https://b/x.png", "status": 404},
                {"url": "/local.png", "asset": 0},
                {"url": "https://a/x.png", "asset": 0}
            ]),
        );
        assert_eq!(
            table(&p),
            "const IMAGES: &'static [runic_runtime::images::PinnedImage] = &[\
             runic_runtime::images::PinnedImage { url: \"/local.png\", image: Ok((\"image/png\", include_bytes!(\"../images/0\"))) }, \
             runic_runtime::images::PinnedImage { url: \"https://a/x.png\", image: Ok((\"image/png\", include_bytes!(\"../images/0\"))) }, \
             runic_runtime::images::PinnedImage { url: \"https://b/x.png\", image: Err(404) }, ];\n"
        );
    }
}
