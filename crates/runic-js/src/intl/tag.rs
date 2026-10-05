//! Language tags of `Intl.PluralRules` and `Intl.DisplayNames`: a language
//! with an optional script and region, canonicalized as V8 does (case, then
//! the aliases of Chromium's ICU data, `locale_data.rs`).
//!
//! Tags that are not well formed throw a RangeError, as in Chromium. Other
//! well-formed shapes (variants, extensions, private use) are not modelled:
//! they are reported unsupported (`RunicUnsupportedError`), never
//! approximated.

use super::locale_data::{LANGUAGE_ALIASES, REGION_ALIASES, SCRIPT_ALIASES};
use crate::Throw;

/// Which canonicalization applies: V8's for locale arguments
/// (CanonicalizeLocaleList) or ICU's for `DisplayNames#of` codes; they
/// differ in a few language aliases (`bh`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    List,
    Name,
}

/// A canonical tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub language: String,
    pub script: Option<String>,
    pub region: Option<String>,
}

impl Tag {
    /// The BCP 47 form (`sr-Latn-RS`).
    pub fn bcp47(&self) -> String {
        let mut s = self.language.clone();
        for part in [&self.script, &self.region].into_iter().flatten() {
            s.push('-');
            s.push_str(part);
        }
        s
    }
}

/// Why a tag has no value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TagError {
    /// Not well formed: JavaScript throws a RangeError.
    Invalid,
    /// Well formed, outside the modelled shapes.
    Unsupported(String),
}

impl TagError {
    /// The exception JavaScript (or Runic) throws.
    pub fn throw(&self, tag: &str) -> Throw {
        match self {
            TagError::Invalid => Throw::range_error(format!("Invalid language tag: {tag}")),
            TagError::Unsupported(why) => unsupported(why),
        }
    }
}

/// The error of a value outside the verified data (docs/IR.md: the runtime
/// reports it; probes and the interpreter stop).
pub fn unsupported(what: &str) -> Throw {
    Throw::new("RunicUnsupportedError", what)
}

fn is_alpha(s: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic())
}

/// Whether `s` is a region subtag (two letters or three digits).
pub fn is_region(s: &str) -> bool {
    is_alpha(s, 2..=2) || (s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
}

/// Parses and canonicalizes `tag`.
pub fn parse(tag: &str, kind: Kind) -> Result<Tag, TagError> {
    let well_formed = !tag.is_empty()
        && tag
            .split('-')
            .all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()));
    if !well_formed {
        return Err(TagError::Invalid);
    }
    let parts: Vec<&str> = tag.split('-').collect();
    // Intl's tags start with a language subtag (not a script, private use or
    // a legacy form).
    if !(is_alpha(parts[0], 2..=3) || is_alpha(parts[0], 5..=8)) {
        return Err(TagError::Invalid);
    }
    let mut t = Tag {
        language: parts[0].to_ascii_lowercase(),
        script: None,
        region: None,
    };
    let mut i = 1;
    if let Some(s) = parts.get(i).filter(|s| is_alpha(s, 4..=4)) {
        t.script = Some(s[..1].to_ascii_uppercase() + &s[1..].to_ascii_lowercase());
        i += 1;
    }
    if let Some(r) = parts.get(i).filter(|r| is_region(r)) {
        t.region = Some(r.to_ascii_uppercase());
        i += 1;
    }
    if i < parts.len() {
        return Err(TagError::Unsupported(format!(
            "the language tag {tag}: runic models a language with an optional script and region (no variants or extensions)"
        )));
    }
    canonicalize(t, kind)
}

fn alias<'a>(table: &'a [(&'static str, &'static str)], key: &str) -> Option<&'a str> {
    table
        .binary_search_by(|(k, _)| (*k).cmp(key))
        .ok()
        .map(|i| table[i].1)
}

fn language_alias(key: &str, kind: Kind) -> Option<&'static str> {
    let i = LANGUAGE_ALIASES
        .binary_search_by(|(k, _, _)| (*k).cmp(key))
        .ok()?;
    let (_, list, name) = LANGUAGE_ALIASES[i];
    let r = if kind == Kind::List { list } else { name };
    (!r.is_empty()).then_some(r)
}

/// Applies the aliases until none matches: a language (or language and
/// region) is replaced, its replacement's script and region filling absent
/// ones; scripts and regions with one replacement are replaced. A region
/// aliasing several regions depends on the language's likely region, which
/// is not modelled.
fn canonicalize(mut t: Tag, kind: Kind) -> Result<Tag, TagError> {
    for _ in 0..8 {
        let mut changed = false;
        let compound = t
            .region
            .as_ref()
            .and_then(|r| language_alias(&format!("{}_{r}", t.language), kind));
        let replacement = match compound {
            Some(rep) => {
                t.region = None;
                Some(rep)
            }
            None => language_alias(&t.language, kind),
        };
        if let Some(rep) = replacement {
            let mut parts = rep.split('_');
            t.language = parts.next().expect("language").to_string();
            for p in parts {
                if p.len() == 4 {
                    t.script.get_or_insert_with(|| p.to_string());
                } else {
                    t.region.get_or_insert_with(|| p.to_string());
                }
            }
            changed = true;
        }
        if let Some(s) = t.script.as_deref().and_then(|s| alias(SCRIPT_ALIASES, s)) {
            t.script = Some(s.to_string());
            changed = true;
        }
        if let Some(r) = t.region.as_deref().and_then(|r| alias(REGION_ALIASES, r)) {
            if r.contains(' ') {
                return Err(TagError::Unsupported(format!(
                    "the region {} in a language tag: it aliases several regions ({r}), chosen by the language's likely region",
                    t.region.as_deref().unwrap_or_default()
                )));
            }
            t.region = Some(r.to_string());
            changed = true;
        }
        if !changed {
            return Ok(t);
        }
    }
    Ok(t)
}
