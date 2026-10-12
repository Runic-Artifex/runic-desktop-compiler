//! Pinned image URLs (M6, docs/design/M6-IMAGES.md). `runic images <app>`
//! fetched each URL the program can load once; the generated app embeds the
//! bytes, or the HTTP status of a pinned failure, in `App::IMAGES`. Image
//! loading does not use the table yet (the net provider follows in step 4).

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
