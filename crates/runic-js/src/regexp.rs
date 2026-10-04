//! `RegExp` objects with ECMAScript semantics (docs/IR.md, built-ins; M5).
//!
//! Matching uses the `regress` engine, which implements ECMAScript pattern
//! syntax and semantics, over UTF-16 code units: code points with the `u`
//! and `v` flags, code units otherwise, so indices and `lastIndex` count
//! UTF-16 units exactly as in JavaScript. This module implements the
//! abstract operations around the matcher: RegExpInitialize (flags and
//! syntax errors), RegExpBuiltinExec (`lastIndex`, global and sticky),
//! `@@replace` with GetSubstitution, `@@split`, `@@match`, `@@matchAll` and
//! `@@search`. Tests compare with Node (tests/vectors/regexp.json).
//!
//! Where V8 and the specification disagree, V8 is followed (it is the
//! reference the conformance suite runs): with a Unicode flag, a
//! `lastIndex` inside a surrogate pair moves back to the pair's start.
//!
//! Match arrays are ordinary arrays; their extra properties (`index`,
//! `input`, `groups`) live in a side table keyed by the array's storage.

use crate::{
    ArrayElement, JsArray, JsResult, JsString, MapKey, Maybe, StrictEq, Throw, ToJsString,
    ToMapKey, ToNumber, Truthy, TypeOf, array,
};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

/// The flags of a regular expression (`dgimsuvy`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Flags {
    pub has_indices: bool,
    pub global: bool,
    pub ignore_case: bool,
    pub multiline: bool,
    pub dot_all: bool,
    pub unicode: bool,
    pub unicode_sets: bool,
    pub sticky: bool,
}

impl Flags {
    /// Parses a flags string; `None` when it has an unknown or repeated
    /// flag, or both `u` and `v` (RegExpInitialize step 3 and 4).
    pub fn parse(flags: &[u16]) -> Option<Flags> {
        let mut f = Flags::default();
        for &u in flags {
            let slot = match u {
                0x64 => &mut f.has_indices,
                0x67 => &mut f.global,
                0x69 => &mut f.ignore_case,
                0x6D => &mut f.multiline,
                0x73 => &mut f.dot_all,
                0x75 => &mut f.unicode,
                0x76 => &mut f.unicode_sets,
                0x79 => &mut f.sticky,
                _ => return None,
            };
            if *slot {
                return None;
            }
            *slot = true;
        }
        if f.unicode && f.unicode_sets {
            return None;
        }
        Some(f)
    }
    /// The canonical flags string (`get RegExp.prototype.flags`).
    pub fn to_js_string(self) -> JsString {
        let mut s = String::new();
        for (on, c) in [
            (self.has_indices, 'd'),
            (self.global, 'g'),
            (self.ignore_case, 'i'),
            (self.multiline, 'm'),
            (self.dot_all, 's'),
            (self.unicode, 'u'),
            (self.unicode_sets, 'v'),
            (self.sticky, 'y'),
        ] {
            if on {
                s.push(c);
            }
        }
        JsString::from(s)
    }
    /// Code point matching (`u` or `v`).
    pub fn full_unicode(self) -> bool {
        self.unicode || self.unicode_sets
    }
}

struct Inner {
    /// The pattern text as written ([[OriginalSource]]).
    pattern: JsString,
    flags: Flags,
    /// The program for inputs that need no stand-ins (see [`stand_in`]).
    program: Rc<regress::Regex>,
    last_index: Cell<f64>,
    /// The input last prepared for matching, with its program and remapped
    /// code units (global loops match one input many times).
    prepared: RefCell<Option<Prepared>>,
}

#[derive(Clone)]
struct Prepared {
    input: JsString,
    program: Rc<regress::Regex>,
    haystack: Option<Rc<[u16]>>,
}

/// A RegExp object: compared by identity; `lastIndex` is its only mutable
/// state.
#[derive(Clone)]
pub struct RegExp(Rc<Inner>);

impl std::fmt::Debug for RegExp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_js_string())
    }
}

type ProgramKey = (Vec<u16>, Flags, u32);

thread_local! {
    /// Compiled programs by pattern, flags and stand-in block (a literal
    /// compiles once).
    static PROGRAMS: RefCell<HashMap<ProgramKey, Result<Rc<regress::Regex>, String>>> =
        RefCell::new(HashMap::new());
}

fn is_lead(u: u16) -> bool {
    (0xD800..0xDC00).contains(&u)
}

fn is_trail(u: u16) -> bool {
    (0xDC00..0xE000).contains(&u)
}

fn hex4(units: &[u16]) -> Option<u16> {
    if units.len() < 4 {
        return None;
    }
    let mut v = 0u16;
    for &u in &units[..4] {
        let d = char::from_u32(u32::from(u))?.to_digit(16)?;
        v = v * 16 + d as u16;
    }
    Some(v)
}

// ---------------------------------------------------------------------------
// Case-insensitive matching where `regress` deviates from ECMAScript.
//
// Without a Unicode flag, Canonicalize is "the single code unit uppercase,
// unless it maps non-ASCII to ASCII"; `regress` uses Unicode case folding
// for classes and a simple uppercase table for characters, which relates
// the characters below to others. In ECMAScript each of them matches only
// itself. Matching therefore replaces them, in the input and in the
// pattern, by caseless stand-ins from a block of code units the input does
// not contain (private use, else CJK ideographs), so that they too match
// only themselves. Ranges covering them are split accordingly, and the
// block's own characters, absent from the input, are dropped from the
// pattern.
//
// With `u` or `v`, `regress` closes a class containing `\W` under case
// folding again, which adds s, k, S, K, ſ and K back; such a `\W` is
// written as explicit ranges instead.

/// Characters that only match themselves under non-Unicode case-insensitive
/// matching but not in `regress`: ı ſ ϴ ẞ Ω K Å and the Greek letters with
/// iota subscript (found exhaustively by tests/vectors/regexp.json, `icase`).
const CASELESS_NON_UNICODE: &[(u32, u32)] = &[
    (0x0131, 0x0131),
    (0x017F, 0x017F),
    (0x03F4, 0x03F4),
    (0x1E9E, 0x1E9E),
    (0x1F80, 0x1FAF),
    (0x1FB3, 0x1FB3),
    (0x1FBC, 0x1FBC),
    (0x1FC3, 0x1FC3),
    (0x1FCC, 0x1FCC),
    (0x1FF3, 0x1FF3),
    (0x1FFC, 0x1FFC),
    (0x2126, 0x2126),
    (0x212A, 0x212B),
];
/// The size of a stand-in block.
const BLOCK: u32 = 64;
/// Stand-in blocks: the private use area, then CJK ideographs (caseless,
/// neither word characters nor white space nor line terminators).
const BLOCKS: &[(u32, u32)] = &[(0xE000, 0xF8FF), (0x4E00, 0x9FFF)];

/// Whether matching uses stand-ins (non-Unicode case-insensitive).
fn remaps_input(flags: Flags) -> bool {
    flags.ignore_case && !flags.full_unicode()
}

fn caseless(c: u32) -> bool {
    CASELESS_NON_UNICODE
        .iter()
        .any(|&(a, b)| (a..=b).contains(&c))
}

/// The stand-in of a caseless character in the block at `base`.
fn stand_in(c: u32, base: u32) -> Option<u32> {
    let mut k = 0;
    for &(a, b) in CASELESS_NON_UNICODE {
        if (a..=b).contains(&c) {
            return Some(base + k + (c - a));
        }
        k += b - a + 1;
    }
    None
}

/// The first stand-in block none of whose code units occur in `units`.
fn choose_block(units: &[u16]) -> Option<u32> {
    let mut used = std::collections::HashSet::new();
    for &u in units {
        let u = u32::from(u);
        if BLOCKS.iter().any(|&(a, b)| (a..=b).contains(&u)) {
            used.insert(
                u - (u - BLOCKS
                    .iter()
                    .find(|&&(a, b)| (a..=b).contains(&u))
                    .unwrap()
                    .0)
                    % BLOCK,
            );
        }
    }
    BLOCKS
        .iter()
        .flat_map(|&(a, b)| (a..b.saturating_sub(BLOCK - 1)).step_by(BLOCK as usize))
        .find(|base| !used.contains(base))
}

fn ascii(c: u32, b: u8) -> bool {
    c == u32::from(b)
}

/// `\W` (complement of the word characters) as ranges: with `u` and `i`
/// without ſ and K, whose case folds are word characters
/// (WordCharacters); without `u` up to U+FFFF.
fn non_word_ranges(full_unicode: bool) -> Vec<(u32, u32)> {
    let mut ranges = vec![(0, 0x2F), (0x3A, 0x40), (0x5B, 0x5E), (0x60, 0x60)];
    if full_unicode {
        ranges.extend([(0x7B, 0x017E), (0x0180, 0x2129), (0x212B, 0x10FFFF)]);
    } else {
        ranges.push((0x7B, 0xFFFF));
    }
    ranges
}

fn push_escape(out: &mut Vec<u32>, c: u32, full_unicode: bool) {
    if !full_unicode && (0xD800..0xE000).contains(&c) {
        // A raw code unit: escaped surrogates would pair up.
        out.push(c);
        return;
    }
    let text = if full_unicode {
        format!("\\u{{{c:X}}}")
    } else {
        format!("\\u{c:04X}")
    };
    out.extend(text.chars().map(u32::from));
}

/// One element of a non-Unicode character class.
#[derive(Clone, Debug)]
enum ClassAtom {
    /// A character, with whether it was a raw `-`.
    Char(u32, bool),
    /// A class escape (`\d`, `\W`, …), kept as written.
    Other(Vec<u32>),
}

/// Reads an escape at `p[i] == '\\'` in a non-Unicode pattern: its end
/// and, for a character escape, the code unit it denotes.
fn read_escape(p: &[u32], i: usize, in_class: bool) -> (usize, Option<u32>) {
    let Some(&n) = p.get(i + 1) else {
        return (p.len(), None);
    };
    let hex = |from: usize, len: usize| -> Option<u32> {
        let digits = p.get(from..from + len)?;
        let mut v = 0;
        for &d in digits {
            v = v * 16 + char::from_u32(d)?.to_digit(16)?;
        }
        Some(v)
    };
    let digit = |j: usize, radix: u32| p.get(j).and_then(|&c| char::from_u32(c)?.to_digit(radix));
    match char::from_u32(n).unwrap_or('\0') {
        'u' => match hex(i + 2, 4) {
            Some(v) => (i + 6, Some(v)),
            None => (i + 2, Some(n)),
        },
        'x' => match hex(i + 2, 2) {
            Some(v) => (i + 4, Some(v)),
            None => (i + 2, Some(n)),
        },
        'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'B' => (i + 2, None),
        'b' if in_class => (i + 2, Some(8)),
        'b' => (i + 2, None),
        'c' => match p.get(i + 2).and_then(|&c| char::from_u32(c)) {
            Some(c)
                if c.is_ascii_alphabetic() || (in_class && (c.is_ascii_digit() || c == '_')) =>
            {
                (i + 3, Some(u32::from(c) % 32))
            }
            // A literal backslash; the `c` follows as itself.
            _ => (i + 1, Some(u32::from(b'\\'))),
        },
        // In a class: a legacy octal escape (or `\8`, `\9` as themselves).
        '0'..='7' if in_class => {
            let first = digit(i + 1, 8).unwrap_or(0);
            let max = if first <= 3 { 3 } else { 2 };
            let mut j = i + 2;
            let mut v = first;
            while j < i + 1 + max {
                match digit(j, 8) {
                    Some(d) => {
                        v = v * 8 + d;
                        j += 1;
                    }
                    None => break,
                }
            }
            (j, Some(v))
        }
        // Outside a class: back references or octal escapes, kept as written.
        '0'..='9' if !in_class => {
            let mut j = i + 1;
            while digit(j, 10).is_some() {
                j += 1;
            }
            (j, None)
        }
        'f' => (i + 2, Some(0x0C)),
        'n' => (i + 2, Some(0x0A)),
        'r' => (i + 2, Some(0x0D)),
        't' => (i + 2, Some(0x09)),
        'v' => (i + 2, Some(0x0B)),
        _ => (i + 2, Some(n)),
    }
}

/// The parts of `[a, b]` without caseless characters and the block at
/// `base`, followed by the stand-ins of the caseless characters in it.
fn split_range(a: u32, b: u32, base: u32) -> (Vec<(u32, u32)>, Vec<u32>) {
    let mut cuts: Vec<(u32, u32)> = CASELESS_NON_UNICODE.to_vec();
    cuts.push((base, base + BLOCK - 1));
    cuts.sort_unstable();
    let mut parts = vec![];
    let mut from = a;
    for (x, y) in cuts {
        if y < from || x > b {
            continue;
        }
        if x > from {
            parts.push((from, x - 1));
        }
        from = from.max(y + 1);
    }
    if from <= b {
        parts.push((from, b));
    }
    let stand_ins = (a..=b)
        .filter(|&c| caseless(c))
        .filter_map(|c| stand_in(c, base))
        .collect();
    (parts, stand_ins)
}

/// A non-Unicode case-insensitive pattern with caseless characters replaced
/// by their stand-ins at `base` (see above).
fn rewrite_non_unicode_icase(p: &[u32], base: u32) -> Vec<u32> {
    let in_block = |c: u32| (base..base + BLOCK).contains(&c);
    // A character of the pattern: its stand-in, nothing that matches (a
    // block character, absent from the input), or itself.
    let char_out = |out: &mut Vec<u32>, c: u32, text: &[u32]| {
        if let Some(s) = stand_in(c, base) {
            out.push(s);
        } else if in_block(c) {
            out.extend("[]".chars().map(u32::from));
        } else {
            out.extend_from_slice(text);
        }
    };
    let mut out: Vec<u32> = Vec::with_capacity(p.len());
    let mut i = 0;
    while i < p.len() {
        let c = p[i];
        if ascii(c, b'\\') {
            // `\k<name>`: the name is kept as written.
            if p.get(i + 1).is_some_and(|&c| ascii(c, b'k'))
                && p.get(i + 2).is_some_and(|&c| ascii(c, b'<'))
            {
                let end = p[i..]
                    .iter()
                    .position(|&c| ascii(c, b'>'))
                    .map_or(p.len(), |k| i + k + 1);
                out.extend_from_slice(&p[i..end]);
                i = end;
                continue;
            }
            let (end, value) = read_escape(p, i, false);
            let end = end.clamp(i + 1, p.len());
            match value {
                Some(v) => char_out(&mut out, v, &p[i..end]),
                None => out.extend_from_slice(&p[i..end]),
            }
            i = end;
        } else if ascii(c, b'(')
            && p.get(i + 1).is_some_and(|&c| ascii(c, b'?'))
            && p.get(i + 2).is_some_and(|&c| ascii(c, b'<'))
            && !p
                .get(i + 3)
                .is_some_and(|&c| ascii(c, b'=') || ascii(c, b'!'))
        {
            // A group name is kept as written.
            let end = p[i..]
                .iter()
                .position(|&c| ascii(c, b'>'))
                .map_or(p.len(), |k| i + k + 1);
            out.extend_from_slice(&p[i..end]);
            i = end;
        } else if ascii(c, b'[') {
            match rewrite_class(p, i, base) {
                Some((end, class)) => {
                    out.extend(class);
                    i = end;
                }
                None => {
                    // Unterminated: left to the engine (validated before).
                    out.extend_from_slice(&p[i..]);
                    i = p.len();
                }
            }
        } else {
            char_out(&mut out, c, &[c]);
            i += 1;
        }
    }
    out
}

/// The non-Unicode class at `p[start] == '['` rewritten for the stand-ins
/// at `base`, and its end.
fn rewrite_class(p: &[u32], start: usize, base: u32) -> Option<(usize, Vec<u32>)> {
    let mut i = start + 1;
    let negated = p.get(i).is_some_and(|&c| ascii(c, b'^'));
    if negated {
        i += 1;
    }
    let mut atoms: Vec<ClassAtom> = vec![];
    loop {
        let &c = p.get(i)?;
        if ascii(c, b']') {
            break;
        }
        if ascii(c, b'\\') {
            let (end, value) = read_escape(p, i, true);
            let end = end.clamp(i + 1, p.len());
            atoms.push(match value {
                Some(v) => ClassAtom::Char(v, false),
                None => ClassAtom::Other(p[i..end].to_vec()),
            });
            i = end;
        } else {
            atoms.push(ClassAtom::Char(c, ascii(c, b'-')));
            i += 1;
        }
    }
    let end = i + 1;
    let mut out = vec![u32::from(b'[')];
    if negated {
        out.push(u32::from(b'^'));
    }
    let range_out = |out: &mut Vec<u32>, a: u32, b: u32| {
        let (parts, stand_ins) = split_range(a, b, base);
        for (x, y) in parts {
            push_escape(out, x, false);
            if y > x {
                out.push(u32::from(b'-'));
                push_escape(out, y, false);
            }
        }
        out.extend(stand_ins);
    };
    // Ranges are Char '-' Char; next to a class escape '-' is itself
    // (Annex B).
    let mut k = 0;
    while k < atoms.len() {
        if let (
            ClassAtom::Char(a, _),
            Some(ClassAtom::Char(_, true)),
            Some(ClassAtom::Char(b, _)),
        ) = (&atoms[k], atoms.get(k + 1), atoms.get(k + 2))
        {
            if a > b {
                // A syntax error, reported from the pattern as written.
                return Some((end, p[start..end].to_vec()));
            }
            range_out(&mut out, *a, *b);
            k += 3;
            continue;
        }
        match &atoms[k] {
            ClassAtom::Char(c, _) => range_out(&mut out, *c, *c),
            ClassAtom::Other(t) if t.len() == 2 && ascii(t[1], b'W') => {
                for (a, b) in non_word_ranges(false) {
                    range_out(&mut out, a, b);
                }
            }
            ClassAtom::Other(t) => out.extend_from_slice(t),
        }
        k += 1;
    }
    out.push(u32::from(b']'));
    Some((end, out))
}

/// `\W` in the classes of a Unicode case-insensitive pattern as explicit
/// ranges (nested classes with `v`). `None` when there is none.
fn rewrite_unicode_icase(p: &[u32], sets: bool) -> Option<Vec<u32>> {
    let mut out = Vec::with_capacity(p.len());
    let mut depth = 0usize;
    let mut changed = false;
    let mut i = 0;
    while i < p.len() {
        let c = p[i];
        if ascii(c, b'\\') && i + 1 < p.len() {
            if depth > 0 && ascii(p[i + 1], b'W') {
                if sets {
                    out.push(u32::from(b'['));
                }
                for (a, b) in non_word_ranges(true) {
                    push_escape(&mut out, a, true);
                    out.push(u32::from(b'-'));
                    push_escape(&mut out, b, true);
                }
                if sets {
                    out.push(u32::from(b']'));
                }
                changed = true;
            } else {
                out.extend_from_slice(&p[i..i + 2]);
            }
            i += 2;
            continue;
        }
        if ascii(c, b'[') && (depth == 0 || sets) {
            depth += 1;
        } else if ascii(c, b']') && depth > 0 {
            depth -= 1;
        }
        out.push(c);
        i += 1;
    }
    changed.then_some(out)
}

/// The pattern as the code points `regress` parses. With a Unicode flag the
/// pattern is a sequence of code points; otherwise of code units. In the
/// latter case `regress` would still join an escaped surrogate pair
/// (`😀`) into one code point, which never matches code units:
/// the trail escape is passed as the raw code unit instead, which denotes
/// the same character.
fn pattern_chars(pattern: &[u16], flags: Flags) -> Vec<u32> {
    if flags.full_unicode() {
        return char::decode_utf16(pattern.iter().copied())
            .map(|r| r.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from))
            .collect();
    }
    let mut out = Vec::with_capacity(pattern.len());
    let mut i = 0;
    while i < pattern.len() {
        let u = pattern[i];
        if u == u16::from(b'\\') && i + 1 < pattern.len() {
            let next = pattern[i + 1];
            if next == u16::from(b'u') && hex4(&pattern[i + 2..]).is_some_and(is_lead) {
                let after = i + 6;
                if pattern.get(after) == Some(&u16::from(b'\\'))
                    && pattern.get(after + 1) == Some(&u16::from(b'u'))
                {
                    if let Some(trail) = hex4(&pattern[after + 2..]).filter(|&v| is_trail(v)) {
                        out.extend(pattern[i..after].iter().map(|&u| u32::from(u)));
                        out.push(u32::from(trail));
                        i = after + 6;
                        continue;
                    }
                }
            }
            out.push(u32::from(u));
            out.push(u32::from(next));
            i += 2;
            continue;
        }
        out.push(u32::from(u));
        i += 1;
    }
    out
}

/// The program for `pattern` with `flags`; for non-Unicode
/// case-insensitive patterns, with stand-ins in the block at `base`.
fn compile(pattern: &[u16], flags: Flags, base: u32) -> Result<Rc<regress::Regex>, String> {
    let key = (pattern.to_vec(), flags, base);
    if let Some(p) = PROGRAMS.with(|c| c.borrow().get(&key).cloned()) {
        return p;
    }
    let rflags = regress::Flags {
        icase: flags.ignore_case,
        multiline: flags.multiline,
        dot_all: flags.dot_all,
        no_opt: false,
        unicode: flags.unicode,
        unicode_sets: flags.unicode_sets,
    };
    let chars = pattern_chars(pattern, flags);
    // Validate as written (errors as written), then compile the pattern
    // rewritten around the engine's case-insensitive deviations.
    let rewritten = if !flags.ignore_case {
        None
    } else if flags.full_unicode() {
        rewrite_unicode_icase(&chars, flags.unicode_sets)
    } else {
        Some(rewrite_non_unicode_icase(&chars, base))
    };
    let result = match rewritten {
        None => regress::Regex::from_unicode(chars.into_iter(), rflags),
        Some(r) => regress::Regex::from_unicode(chars.into_iter(), rflags)
            .and_then(|_| regress::Regex::from_unicode(r.into_iter(), rflags)),
    }
    .map(Rc::new)
    .map_err(|e| e.text);
    PROGRAMS.with(|c| {
        let mut c = c.borrow_mut();
        // Patterns built at runtime: keep the cache bounded.
        if c.len() >= 512 {
            c.clear();
        }
        c.insert(key, result.clone());
    });
    result
}

/// The pattern's code units outside classes and escapes, in order.
fn syntax_units(p: &[u16]) -> Vec<u16> {
    let mut out = vec![];
    let mut in_class = false;
    let mut i = 0;
    while i < p.len() {
        let u = p[i];
        if u == u16::from(b'\\') {
            i += 2;
            continue;
        }
        if in_class {
            in_class = u != u16::from(b']');
        } else if u == u16::from(b'[') {
            in_class = true;
        } else {
            out.push(u);
        }
        i += 1;
    }
    out
}

/// V8's wording of a syntax error that `regress` reports as `text`: the
/// engines word their errors differently, so the reason is derived from
/// the error kind and the pattern.
fn v8_reason(text: &str, pattern: &[u16], flags: Flags) -> String {
    let unicode = flags.full_unicode();
    let s = String::from_utf16_lossy(pattern);
    let reason = match text {
        "Unbalanced parenthesis" => {
            let mut depth = 0i32;
            let mut unmatched = false;
            for u in syntax_units(pattern) {
                if u == u16::from(b'(') {
                    depth += 1;
                } else if u == u16::from(b')') {
                    depth -= 1;
                    unmatched |= depth < 0;
                }
            }
            if unmatched {
                "Unmatched ')'"
            } else {
                "Unterminated group"
            }
        }
        "Invalid atom character" => {
            let lone = unicode
                && syntax_units(pattern)
                    .iter()
                    .any(|&u| u == u16::from(b']') || u == u16::from(b'{') || u == u16::from(b'}'));
            if lone {
                "Lone quantifier brackets"
            } else {
                "Nothing to repeat"
            }
        }
        "Invalid quantifier" => {
            let reversed = s.split('{').skip(1).any(|q| {
                let body = q.split('}').next().unwrap_or("");
                match body.split_once(',') {
                    Some((a, b)) => match (a.parse::<f64>(), b.parse::<f64>()) {
                        (Ok(a), Ok(b)) => a > b,
                        _ => false,
                    },
                    None => false,
                }
            });
            if reversed {
                "numbers out of order in {} quantifier"
            } else {
                "Incomplete quantifier"
            }
        }
        "Quantifier not allowed here" => "Invalid quantifier",
        "Invalid character range" => "Invalid character class",
        "Unbalanced bracket" => "Unterminated character class",
        "Incomplete escape" | "Unterminated escape" => "\\ at end of pattern",
        "Invalid braced quantifier" => "numbers out of order in {} quantifier",
        "Invalid property name" | "Invalid property escape" => "Invalid property name",
        "Invalid token at named capture group identifier" => {
            if s.contains("(?<") {
                "Invalid capture group name"
            } else {
                "Invalid group"
            }
        }
        "Invalid group modifier" => {
            let repeated = s.split("(?").skip(1).any(|g| {
                let mods: Vec<char> = g
                    .chars()
                    .take_while(|c| c.is_ascii_lowercase() || *c == '-')
                    .collect();
                let letters: Vec<char> = mods.iter().copied().filter(|c| *c != '-').collect();
                (0..letters.len()).any(|i| letters[i + 1..].contains(&letters[i]))
            });
            if repeated {
                "Repeated flag in flag group"
            } else {
                "Invalid group"
            }
        }
        "Invalid character at property escape start" => "Invalid property name",
        "Invalid named backreference syntax" => {
            if s.split("\\k<").skip(1).any(|r| !r.contains('>')) {
                "Invalid capture group name"
            } else {
                "Invalid named reference"
            }
        }
        "Invalid unicode escape" => "Invalid Unicode escape",
        "Invalid character escape" => {
            let mut reason = "Invalid escape";
            let mut i = 0;
            while i + 1 < pattern.len() {
                if pattern[i] == u16::from(b'\\') {
                    let n = pattern[i + 1];
                    let next_digit = pattern
                        .get(i + 2)
                        .is_some_and(|&d| (0x30..=0x39).contains(&d));
                    let next_letter = pattern.get(i + 2).is_some_and(|&d| {
                        char::from_u32(u32::from(d)).is_some_and(|c| c.is_ascii_alphabetic())
                    });
                    if n == u16::from(b'c') && !next_letter {
                        reason = "Invalid Unicode escape";
                        break;
                    }
                    if n == u16::from(b'0') && next_digit {
                        reason = "Invalid decimal escape";
                        break;
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
            reason
        }
        "Unbalanced class set bracket"
        | "Invalid class set character"
        | "Incomplete class set character"
        | "Empty class set operand" => "Invalid character in character class",
        "Unexpected character in class set subtraction"
        | "Unexpected character in class set intersection"
        | "Invalid class set range" => "Invalid set operation in character class",
        "Capture group count limit exceeded" => "Too many captures",
        "Regular expression is too deeply nested" | "Loop count limit exceeded" => {
            "Regular expression too large"
        }
        other if other.starts_with("Range values reversed") => {
            "Range out of order in character class"
        }
        other if other.starts_with("Backreference to invalid named capture group") => {
            "Invalid named capture referenced"
        }
        other => other,
    };
    reason.to_string()
}

fn syntax_error(pattern: &JsString, flags: &JsString, f: Flags, reason: &str) -> Throw {
    Throw::syntax_error(format!(
        "Invalid regular expression: /{}/{}: {}",
        pattern.to_rust(),
        flags.to_rust(),
        v8_reason(reason, pattern.units(), f)
    ))
}

/// ToLength (7.1.20).
fn to_length(x: f64) -> f64 {
    if x.is_nan() || x <= 0.0 {
        0.0
    } else {
        x.trunc().min(9007199254740991.0)
    }
}

/// AdvanceStringIndex (22.2.7.3).
fn advance(s: &[u16], index: usize, unicode: bool) -> usize {
    if !unicode || index + 1 >= s.len() {
        return index + 1;
    }
    if is_lead(s[index]) && is_trail(s[index + 1]) {
        index + 2
    } else {
        index + 1
    }
}

/// A successful match: capture ranges (0 is the whole match) and named
/// groups in order of their first appearance.
#[derive(Clone, Debug)]
pub struct Matched {
    pub index: usize,
    pub end: usize,
    pub captures: Vec<Maybe<JsString>>,
    /// `None` when the pattern has no named groups (`groups` is undefined).
    pub groups: Option<Rc<Vec<(JsString, Maybe<JsString>)>>>,
}

/// The extra properties of a match array.
#[derive(Clone, Debug)]
pub struct MatchProps {
    pub index: f64,
    pub input: JsString,
    pub groups: Option<Rc<Vec<(JsString, Maybe<JsString>)>>>,
}

thread_local! {
    static MATCH_PROPS: RefCell<(HashMap<usize, (Weak<dyn std::any::Any>, MatchProps)>, usize)> =
        RefCell::new((HashMap::new(), 64));
}

fn attach<T>(a: &JsArray<T>, props: MatchProps) {
    let (key, weak) = a.storage_identity();
    MATCH_PROPS.with(|t| {
        let (table, limit) = &mut *t.borrow_mut();
        if table.len() >= *limit {
            table.retain(|_, (w, _)| w.strong_count() > 0);
            *limit = (table.len() * 2).max(64);
        }
        table.insert(key, (weak, props));
    });
}

/// The extra properties of a match array (`None` for other arrays).
pub fn match_props<T>(a: &JsArray<T>) -> Option<MatchProps> {
    let (key, _) = a.storage_identity();
    MATCH_PROPS.with(|t| {
        let (table, _) = &mut *t.borrow_mut();
        match table.get(&key) {
            Some((w, p)) if w.strong_count() > 0 => Some(p.clone()),
            Some(_) => {
                table.remove(&key);
                None
            }
            None => None,
        }
    })
}

/// `match.index`: undefined for arrays without the property.
pub fn match_index<T>(a: &JsArray<T>) -> Maybe<f64> {
    match_props(a).map_or(Maybe::Undefined, |p| Maybe::Some(p.index))
}

/// `match.input`.
pub fn match_input<T>(a: &JsArray<T>) -> Maybe<JsString> {
    match_props(a).map_or(Maybe::Undefined, |p| Maybe::Some(p.input))
}

/// Whether `match.groups` is an object (the pattern has named groups).
pub fn match_has_groups<T>(a: &JsArray<T>) -> bool {
    match_props(a).is_some_and(|p| p.groups.is_some())
}

/// `match.groups.name`: undefined for a group that did not participate or
/// is not defined; a `TypeError` when `groups` is undefined.
pub fn match_group<T>(a: &JsArray<T>, name: &JsString) -> JsResult<Maybe<JsString>> {
    match match_props(a).and_then(|p| p.groups) {
        Some(groups) => Ok(groups
            .iter()
            .find(|(n, _)| n == name)
            .map_or(Maybe::Undefined, |(_, v)| v.clone())),
        None => Err(Throw::type_error(format!(
            "Cannot read properties of undefined (reading '{}')",
            name.to_rust()
        ))),
    }
}

/// A capture of a match where the program proved it participates (the
/// `string`-element forms of the built-ins).
pub fn present(c: Maybe<JsString>) -> JsResult<JsString> {
    match c {
        Maybe::Some(s) => Ok(s),
        _ => Err(Throw::type_error(
            "A capture group the program declares present did not participate in the match",
        )),
    }
}

impl RegExp {
    /// `new RegExp(pattern, flags)` (RegExpInitialize): a `SyntaxError` for
    /// invalid flags or an invalid pattern.
    pub fn new(pattern: &JsString, flags: &JsString) -> JsResult<RegExp> {
        let Some(f) = Flags::parse(flags.units()) else {
            return Err(Throw::syntax_error(format!(
                "Invalid flags supplied to RegExp constructor '{}'",
                flags.to_rust()
            )));
        };
        let program = compile(pattern.units(), f, BLOCKS[0].0)
            .map_err(|e| syntax_error(pattern, flags, f, &e))?;
        Ok(RegExp(Rc::new(Inner {
            pattern: pattern.clone(),
            flags: f,
            program,
            last_index: Cell::new(0.0),
            prepared: RefCell::new(None),
        })))
    }

    pub fn flags(&self) -> Flags {
        self.0.flags
    }

    /// `get RegExp.prototype.flags`.
    pub fn flags_string(&self) -> JsString {
        self.0.flags.to_js_string()
    }

    /// `get RegExp.prototype.source` (EscapeRegExpPattern as V8 writes it):
    /// `/` outside classes and line terminators are escaped; an empty
    /// pattern reads `(?:)`.
    pub fn source(&self) -> JsString {
        let src = self.0.pattern.units();
        if src.is_empty() {
            return JsString::from("(?:)");
        }
        let line_terminator = |u: u16| matches!(u, 0x0A | 0x0D | 0x2028 | 0x2029);
        let escape = |u: u16| -> &'static str {
            match u {
                0x0A => "\\n",
                0x0D => "\\r",
                0x2028 => "\\u2028",
                _ => "\\u2029",
            }
        };
        let mut out: Vec<u16> = Vec::with_capacity(src.len() + 2);
        let mut in_class = false;
        let mut i = 0;
        while i < src.len() {
            let u = src[i];
            if u == u16::from(b'\\') {
                if i + 1 < src.len() && line_terminator(src[i + 1]) {
                    // The line terminator is escaped below.
                    i += 1;
                    continue;
                }
                out.push(u);
                i += 1;
                if i == src.len() {
                    break;
                }
            } else if u == u16::from(b'/') && !in_class {
                out.push(u16::from(b'\\'));
            } else if u == u16::from(b'[') {
                in_class = true;
            } else if u == u16::from(b']') {
                in_class = false;
            } else if line_terminator(u) {
                out.extend(escape(u).encode_utf16());
                i += 1;
                continue;
            }
            out.push(src[i]);
            i += 1;
        }
        JsString::from_units(out)
    }

    pub fn last_index(&self) -> f64 {
        self.0.last_index.get()
    }

    pub fn set_last_index(&self, v: f64) {
        self.0.last_index.set(v);
    }

    /// The program and code units to match `input` with: for non-Unicode
    /// case-insensitive patterns, caseless characters become stand-ins
    /// from a block the input does not use.
    fn prepare(&self, input: &JsString) -> Prepared {
        if let Some(p) = &*self.0.prepared.borrow() {
            if p.input.units().as_ptr() == input.units().as_ptr() && p.input.len() == input.len() {
                return p.clone();
            }
        }
        let units = input.units();
        let prepared = if !remaps_input(self.0.flags) {
            Prepared {
                input: input.clone(),
                program: self.0.program.clone(),
                haystack: None,
            }
        } else {
            let base = choose_block(units).unwrap_or_else(|| {
                // Every stand-in block occurs in the input (over 400 blocks
                // of private-use and CJK characters): not supported.
                panic!("RegExp input uses every stand-in block")
            });
            let program = if base == BLOCKS[0].0 {
                self.0.program.clone()
            } else {
                compile(self.0.pattern.units(), self.0.flags, base).expect("validated pattern")
            };
            let haystack = units.iter().any(|&u| caseless(u32::from(u))).then(|| {
                units
                    .iter()
                    .map(|&u| stand_in(u32::from(u), base).map_or(u, |s| s as u16))
                    .collect::<Rc<[u16]>>()
            });
            Prepared {
                input: input.clone(),
                program,
                haystack,
            }
        };
        *self.0.prepared.borrow_mut() = Some(prepared.clone());
        prepared
    }

    /// The first match starting at or after `start` (exactly at `start`
    /// when `sticky`).
    fn find(&self, input: &JsString, start: usize, sticky: bool) -> Option<Matched> {
        let prepared = self.prepare(input);
        let s = input.units();
        let hay: &[u16] = prepared.haystack.as_deref().unwrap_or(s);
        let m = if self.0.flags.full_unicode() {
            prepared.program.find_from_utf16(hay, start).next()
        } else {
            prepared.program.find_from_ucs2(hay, start).next()
        }?;
        if sticky && m.start() != start {
            return None;
        }
        let units = |r: Option<regress::Range>| match r {
            Some(r) => Maybe::Some(JsString::from_units(s[r].to_vec())),
            None => Maybe::Undefined,
        };
        let captures = m.groups().map(units).collect();
        let named: Vec<(JsString, Maybe<JsString>)> = m
            .named_groups()
            .map(|(n, r)| (JsString::from(n), units(r)))
            .collect();
        Some(Matched {
            index: m.start(),
            end: m.end(),
            captures,
            groups: (!named.is_empty()).then(|| Rc::new(named)),
        })
    }

    /// RegExpBuiltinExec (22.2.7.2).
    pub fn exec_raw(&self, s: &JsString) -> Option<Matched> {
        let f = self.0.flags;
        let units = s.units();
        let len = units.len();
        let stateful = f.global || f.sticky;
        let last = if stateful {
            to_length(self.0.last_index.get())
        } else {
            0.0
        };
        if last > len as f64 {
            if stateful {
                self.0.last_index.set(0.0);
            }
            return None;
        }
        let mut start = last as usize;
        // V8: a position inside a surrogate pair moves to the pair's start.
        if f.full_unicode() && start > 0 && start < len {
            if is_trail(units[start]) && is_lead(units[start - 1]) {
                start -= 1;
            }
        }
        match self.find(s, start, f.sticky) {
            None => {
                if stateful {
                    self.0.last_index.set(0.0);
                }
                None
            }
            Some(m) => {
                if stateful {
                    self.0.last_index.set(m.end as f64);
                }
                Some(m)
            }
        }
    }

    /// `re.exec(s)`: a match array with `index`, `input` and `groups`.
    pub fn exec(&self, s: &JsString) -> Maybe<JsArray<Maybe<JsString>>> {
        self.exec_with(s, Ok).expect("no conversion error")
    }

    /// `re.exec(s)` with captures converted by `f` (the `string`-element
    /// form passes [`present`]).
    pub fn exec_with<T>(
        &self,
        s: &JsString,
        f: impl FnMut(Maybe<JsString>) -> JsResult<T>,
    ) -> JsResult<Maybe<JsArray<T>>> {
        match self.exec_raw(s) {
            None => Ok(Maybe::Null),
            Some(m) => Ok(Maybe::Some(match_array(m, s, f)?)),
        }
    }

    /// `re.test(s)`.
    pub fn test(&self, s: &JsString) -> bool {
        self.exec_raw(s).is_some()
    }
}

/// A match as an array with its extra properties.
pub fn match_array<T>(
    m: Matched,
    input: &JsString,
    f: impl FnMut(Maybe<JsString>) -> JsResult<T>,
) -> JsResult<JsArray<T>> {
    let items = m
        .captures
        .into_iter()
        .map(f)
        .collect::<JsResult<Vec<T>>>()?;
    let a = array(items);
    attach(
        &a,
        MatchProps {
            index: m.index as f64,
            input: input.clone(),
            groups: m.groups,
        },
    );
    Ok(a)
}

/// GetSubstitution (22.1.3.19.1).
fn get_substitution(out: &mut Vec<u16>, m: &Matched, s: &[u16], template: &[u16]) {
    const DOLLAR: u16 = b'$' as u16;
    let matched: &[u16] = match &m.captures[0] {
        Maybe::Some(x) => x.units(),
        _ => &[],
    };
    let position = m.index;
    let captures = &m.captures[1..];
    let digit = |u: u16| (0x30..=0x39).contains(&u).then(|| usize::from(u - 0x30));
    let mut k = 0;
    while k < template.len() {
        let u = template[k];
        if u != DOLLAR || k + 1 >= template.len() {
            out.push(u);
            k += 1;
            continue;
        }
        let next = template[k + 1];
        match next {
            0x24 => {
                out.push(DOLLAR);
                k += 2;
            }
            0x60 => {
                out.extend_from_slice(&s[..position]);
                k += 2;
            }
            0x26 => {
                out.extend_from_slice(matched);
                k += 2;
            }
            0x27 => {
                let tail = (position + matched.len()).min(s.len());
                out.extend_from_slice(&s[tail..]);
                k += 2;
            }
            _ if digit(next).is_some() => {
                let d1 = digit(next).unwrap();
                let two = template.get(k + 2).and_then(|&u| digit(u));
                let (mut index, mut count) = match two {
                    Some(d2) => (d1 * 10 + d2, 2),
                    None => (d1, 1),
                };
                if index > captures.len() && count == 2 {
                    index = d1;
                    count = 1;
                }
                if (1..=captures.len()).contains(&index) {
                    if let Maybe::Some(c) = &captures[index - 1] {
                        out.extend_from_slice(c.units());
                    }
                } else {
                    out.extend_from_slice(&template[k..k + 1 + count]);
                }
                k += 1 + count;
            }
            0x3C => {
                let gt = template[k..].iter().position(|&u| u == u16::from(b'>'));
                match (gt, &m.groups) {
                    (Some(gt), Some(groups)) => {
                        let name = &template[k + 2..k + gt];
                        if let Some((_, Maybe::Some(v))) =
                            groups.iter().find(|(n, _)| n.units() == name)
                        {
                            out.extend_from_slice(v.units());
                        }
                        k += gt + 1;
                    }
                    _ => {
                        out.extend_from_slice(&template[k..k + 2]);
                        k += 2;
                    }
                }
            }
            _ => {
                out.push(DOLLAR);
                k += 1;
            }
        }
    }
}

/// The results `@@replace` and `@@match` collect: one match, or every
/// match of a global regular expression (empty matches advance
/// `lastIndex`).
fn collect(re: &RegExp, s: &JsString) -> Vec<Matched> {
    let f = re.0.flags;
    if !f.global {
        return re.exec_raw(s).into_iter().collect();
    }
    re.set_last_index(0.0);
    let mut out = Vec::new();
    while let Some(m) = re.exec_raw(s) {
        if m.index == m.end {
            let this = to_length(re.last_index()) as usize;
            re.set_last_index(advance(s.units(), this, f.full_unicode()) as f64);
        }
        out.push(m);
    }
    out
}

/// `@@replace` (22.2.6.11) with a replacement for each match.
fn replace_impl(
    s: &JsString,
    results: Vec<Matched>,
    mut replacement: impl FnMut(&Matched) -> JsResult<Vec<u16>>,
) -> JsResult<JsString> {
    let units = s.units();
    if results.is_empty() {
        return Ok(s.clone());
    }
    let mut out = Vec::with_capacity(units.len());
    let mut next = 0;
    for m in &results {
        let position = m.index.min(units.len());
        let matched_len = match &m.captures[0] {
            Maybe::Some(x) => x.len(),
            _ => 0,
        };
        let r = replacement(m)?;
        if position >= next {
            out.extend_from_slice(&units[next..position]);
            out.extend_from_slice(&r);
            next = position + matched_len;
        }
    }
    if next < units.len() {
        out.extend_from_slice(&units[next..]);
    }
    Ok(JsString::from_units(out))
}

/// `s.replace(re, template)`.
pub fn replace(s: &JsString, re: &RegExp, template: &JsString) -> JsString {
    let results = collect(re, s);
    replace_impl(s, results, |m| {
        let mut r = Vec::new();
        get_substitution(&mut r, m, s.units(), template.units());
        Ok(r)
    })
    .expect("substitution does not throw")
}

/// `s.replace(re, fn)`: `f` receives the captures (0 is the match), the
/// position and the string, after all matches are found.
pub fn replace_with(
    s: &JsString,
    re: &RegExp,
    mut f: impl FnMut(&[Maybe<JsString>], f64, &JsString) -> JsResult<JsString>,
) -> JsResult<JsString> {
    let results = collect(re, s);
    replace_impl(s, results, |m| {
        Ok(f(&m.captures, m.index as f64, s)?.units().to_vec())
    })
}

fn require_global(re: &RegExp, method: &str) -> JsResult<()> {
    if re.0.flags.global {
        Ok(())
    } else {
        Err(Throw::type_error(format!(
            "{method} called with a non-global RegExp argument"
        )))
    }
}

/// `s.replaceAll(re, template)`: a `TypeError` unless `re` is global.
pub fn replace_all(s: &JsString, re: &RegExp, template: &JsString) -> JsResult<JsString> {
    require_global(re, "String.prototype.replaceAll")?;
    Ok(replace(s, re, template))
}

/// `s.replaceAll(re, fn)`.
pub fn replace_all_with(
    s: &JsString,
    re: &RegExp,
    f: impl FnMut(&[Maybe<JsString>], f64, &JsString) -> JsResult<JsString>,
) -> JsResult<JsString> {
    require_global(re, "String.prototype.replaceAll")?;
    replace_with(s, re, f)
}

/// `s.match(re)` (`@@match`): the match array of `exec` for a non-global
/// expression; every matched string for a global one; null without match.
pub fn match_with<T>(
    s: &JsString,
    re: &RegExp,
    mut f: impl FnMut(Maybe<JsString>) -> JsResult<T>,
) -> JsResult<Maybe<JsArray<T>>> {
    if !re.0.flags.global {
        return re.exec_with(s, f);
    }
    let results = collect(re, s);
    if results.is_empty() {
        return Ok(Maybe::Null);
    }
    let items = results
        .into_iter()
        .map(|m| f(m.captures.into_iter().next().expect("whole match")))
        .collect::<JsResult<Vec<T>>>()?;
    Ok(Maybe::Some(array(items)))
}

/// `s.match(re)` with possibly absent captures.
pub fn match_(s: &JsString, re: &RegExp) -> Maybe<JsArray<Maybe<JsString>>> {
    match_with(s, re, Ok).expect("no conversion error")
}

/// `[...s.matchAll(re)]` (`@@matchAll`, iterated to the end: a `TypeError`
/// unless `re` is global; matching runs on a copy, so `re.lastIndex` is
/// read, not changed).
pub fn match_all_with<T>(
    s: &JsString,
    re: &RegExp,
    mut f: impl FnMut(Maybe<JsString>) -> JsResult<T>,
) -> JsResult<JsArray<JsArray<T>>> {
    require_global(re, "String.prototype.matchAll")?;
    let matcher = RegExp(Rc::new(Inner {
        pattern: re.0.pattern.clone(),
        flags: re.0.flags,
        program: re.0.program.clone(),
        last_index: Cell::new(to_length(re.last_index())),
        prepared: RefCell::new(None),
    }));
    let unicode = re.0.flags.full_unicode();
    let mut out = Vec::new();
    while let Some(m) = matcher.exec_raw(s) {
        if m.index == m.end {
            let this = to_length(matcher.last_index()) as usize;
            matcher.set_last_index(advance(s.units(), this, unicode) as f64);
        }
        out.push(match_array(m, s, &mut f)?);
    }
    Ok(array(out))
}

pub fn match_all(s: &JsString, re: &RegExp) -> JsResult<JsArray<JsArray<Maybe<JsString>>>> {
    match_all_with(s, re, Ok)
}

/// `s.search(re)` (`@@search`): `lastIndex` is restored.
pub fn search(s: &JsString, re: &RegExp) -> f64 {
    let previous = re.last_index();
    if !crate::same_value(previous, 0.0) {
        re.set_last_index(0.0);
    }
    let result = re.exec_raw(s);
    if !crate::same_value(re.last_index(), previous) {
        re.set_last_index(previous);
    }
    result.map_or(-1.0, |m| m.index as f64)
}

/// ToUint32 (7.1.7).
fn to_uint32(x: f64) -> u32 {
    crate::to_uint32(x)
}

/// `s.split(re, limit)` (`@@split`): pieces between matches, with the
/// captures of each match; `re` itself is not used (a sticky copy is).
pub fn split_with<T>(
    s: &JsString,
    re: &RegExp,
    limit: Maybe<f64>,
    mut f: impl FnMut(Maybe<JsString>) -> JsResult<T>,
) -> JsResult<JsArray<T>> {
    let lim = match limit {
        Maybe::Undefined => u32::MAX as usize,
        Maybe::Null => 0,
        Maybe::Some(n) => to_uint32(n) as usize,
    };
    let mut out: Vec<T> = Vec::new();
    if lim == 0 {
        return Ok(array(out));
    }
    let units = s.units();
    let size = units.len();
    let unicode = re.0.flags.full_unicode();
    let piece = |a: usize, b: usize| Maybe::Some(JsString::from_units(units[a..b].to_vec()));
    if size == 0 {
        if re.find(s, 0, true).is_some() {
            return Ok(array(out));
        }
        out.push(f(Maybe::Some(s.clone()))?);
        return Ok(array(out));
    }
    let mut p = 0;
    let mut q = p;
    while q < size {
        // The first position from q where the (sticky) splitter matches.
        let Some(m) = re.find(s, q, false) else {
            break;
        };
        if m.index >= size {
            break;
        }
        let e = m.end.min(size);
        if e == p {
            q = advance(units, m.index, unicode);
            continue;
        }
        out.push(f(piece(p, m.index))?);
        if out.len() == lim {
            return Ok(array(out));
        }
        p = e;
        for c in m.captures.into_iter().skip(1) {
            out.push(f(c)?);
            if out.len() == lim {
                return Ok(array(out));
            }
        }
        q = p;
    }
    out.push(f(piece(p, size))?);
    Ok(array(out))
}

pub fn split(s: &JsString, re: &RegExp, limit: Maybe<f64>) -> JsArray<Maybe<JsString>> {
    split_with(s, re, limit, Ok).expect("no conversion error")
}

impl ToJsString for RegExp {
    /// `RegExp.prototype.toString`: `/source/flags`.
    fn to_js_string(&self) -> JsString {
        let mut v: Vec<u16> = vec![u16::from(b'/')];
        v.extend_from_slice(self.source().units());
        v.push(u16::from(b'/'));
        v.extend_from_slice(self.flags_string().units());
        JsString::from_units(v)
    }
}

impl Default for RegExp {
    /// `/(?:)/` (placeholders for unassigned locals).
    fn default() -> Self {
        RegExp::new(&JsString::new(), &JsString::new()).expect("empty pattern")
    }
}

impl PartialEq for RegExp {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
impl Truthy for RegExp {
    fn truthy(&self) -> bool {
        true
    }
}
impl ArrayElement for RegExp {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ToNumber for RegExp {
    fn to_number(&self) -> f64 {
        self.to_js_string().to_number()
    }
}
impl TypeOf for RegExp {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl StrictEq for RegExp {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl ToMapKey for RegExp {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(Rc::as_ptr(&self.0) as *const u8 as usize)
    }
}
impl crate::Own for RegExp {}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> JsString {
        JsString::from(x)
    }
    fn re(p: &str, f: &str) -> RegExp {
        RegExp::new(&s(p), &s(f)).unwrap()
    }

    #[test]
    fn exec_sets_last_index_for_global_and_sticky() {
        let r = re("a", "g");
        let m = r.exec(&s("xaa"));
        assert!(matches!(m, Maybe::Some(_)));
        assert_eq!(r.last_index(), 2.0);
        r.exec(&s("xaa"));
        assert_eq!(r.last_index(), 3.0);
        assert!(matches!(r.exec(&s("xaa")), Maybe::Null));
        assert_eq!(r.last_index(), 0.0);
        let y = re("a", "y");
        assert!(matches!(y.exec(&s("xa")), Maybe::Null));
        y.set_last_index(1.0);
        assert!(matches!(y.exec(&s("xa")), Maybe::Some(_)));
        assert_eq!(y.last_index(), 2.0);
    }

    #[test]
    fn match_arrays_carry_index_and_groups() {
        let r = re("(?<y>\\d{4})-(\\d\\d)?", "");
        let Maybe::Some(m) = r.exec(&s("on 2024-x")) else {
            panic!("match")
        };
        assert_eq!(match_index(&m), Maybe::Some(3.0));
        assert_eq!(match_input(&m), Maybe::Some(s("on 2024-x")));
        assert_eq!(match_group(&m, &s("y")).unwrap(), Maybe::Some(s("2024")));
        assert_eq!(m.borrow()[2], Maybe::Undefined);
        let plain = array(vec![1.0]);
        assert_eq!(match_index(&plain), Maybe::Undefined);
        assert!(match_group(&plain, &s("y")).is_err());
    }

    #[test]
    fn utf16_indices_and_surrogates() {
        let text = JsString::from_units(vec![0xD83D, 0xDE00, 0x61, 0xDE00]);
        // Without u: code units; a lone trail matches inside the pair.
        let r = re("\\uDE00", "g");
        let Maybe::Some(m) = r.exec(&text) else {
            panic!()
        };
        assert_eq!(match_index(&m), Maybe::Some(1.0));
        // With u: the pair is one character.
        let r = re("\\uDE00", "gu");
        let Maybe::Some(m) = r.exec(&text) else {
            panic!()
        };
        assert_eq!(match_index(&m), Maybe::Some(3.0));
        // An escaped pair in a non-Unicode pattern is two code units.
        let r = re("\\uD83D\\uDE00+", "");
        let Maybe::Some(m) = r.exec(&JsString::from_units(vec![0xD83D, 0xDE00, 0xDE00])) else {
            panic!()
        };
        assert_eq!(
            m.borrow()[0],
            Maybe::Some(JsString::from_units(vec![0xD83D, 0xDE00, 0xDE00]))
        );
    }

    #[test]
    fn replace_patterns() {
        let r = re("(?<w>o)(x)?", "g");
        assert_eq!(
            replace(&s("foo"), &r, &s("[$1|$2|$&|$`|$'|$<w>|$$|$3|$<z>]")),
            s("f[o||o|f|o|o|$|$3|][o||o|fo||o|$|$3|]")
        );
        assert!(replace_all(&s("a"), &re("a", ""), &s("b")).is_err());
    }

    #[test]
    fn split_with_captures_and_limits() {
        let parts: Vec<_> = split(&s("a1b2c"), &re("(\\d)", ""), Maybe::Undefined)
            .borrow()
            .clone();
        assert_eq!(parts.len(), 5);
        assert_eq!(
            split(&s("abc"), &re("", ""), Maybe::Some(2.0))
                .borrow()
                .len(),
            2
        );
        assert_eq!(
            split(&s(""), &re("", ""), Maybe::Undefined).borrow().len(),
            0
        );
    }

    #[test]
    fn syntax_errors_and_flags() {
        let e = RegExp::new(&s("("), &s("")).unwrap_err();
        assert_eq!(e.name, s("SyntaxError"));
        assert_eq!(
            e.message,
            s("Invalid regular expression: /(/: Unterminated group")
        );
        assert!(RegExp::new(&s("a"), &s("gg")).is_err());
        assert!(RegExp::new(&s("a"), &s("uv")).is_err());
        assert_eq!(re("a/b", "yg").to_js_string(), s("/a\\/b/gy"));
        assert_eq!(re("", "").source(), s("(?:)"));
    }

    #[test]
    fn search_restores_last_index() {
        let r = re("b", "g");
        r.set_last_index(5.0);
        assert_eq!(search(&s("abc"), &r), 1.0);
        assert_eq!(r.last_index(), 5.0);
    }
}
