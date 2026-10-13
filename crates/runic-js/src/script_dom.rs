//! Script DOM decisions shared by the native runtime and the reference
//! interpreter (M6, docs/design/M6-SCRIPT-DOM.md), so that both build the
//! same nodes.

/// A `classList` operation (DOMTokenList, slice 2).
#[derive(Clone, Debug)]
pub enum ClassOp {
    Add(Vec<String>),
    Remove(Vec<String>),
    /// The token and `force`.
    Toggle(String, Option<bool>),
    Contains(String),
    /// The token and its replacement.
    Replace(String, String),
}

/// A `classList` operation on the `class` attribute `current` (absent:
/// `None`), as the DOM standard's DOMTokenList does it: the attribute after
/// the operation (`None`: unchanged, as where the update steps do not run)
/// and the result (`toggle`, `contains`, `replace`), or the exception name
/// and message for an empty token (`SyntaxError`) or one with ASCII
/// whitespace (`InvalidCharacterError`).
pub fn class_list(
    current: Option<&str>,
    op: &ClassOp,
) -> Result<(Option<String>, bool), (&'static str, String)> {
    let check = |t: &str| -> Result<(), (&'static str, String)> {
        if t.is_empty() {
            return Err((
                "SyntaxError",
                "The token provided must not be empty.".into(),
            ));
        }
        if t.chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r'))
        {
            return Err((
                "InvalidCharacterError",
                format!(
                    "The token provided ('{t}') contains HTML space characters, which are not valid in tokens."
                ),
            ));
        }
        Ok(())
    };
    // The ordered set the attribute holds (duplicates dropped).
    let mut set: Vec<String> = vec![];
    for t in current
        .unwrap_or("")
        .split([' ', '\t', '\n', '\x0c', '\r'])
        .filter(|t| !t.is_empty())
    {
        if !set.iter().any(|s| s == t) {
            set.push(t.to_owned());
        }
    }
    // The update steps: no attribute and an empty set stay so.
    let update = |set: &[String]| -> Option<String> {
        if current.is_none() && set.is_empty() {
            None
        } else {
            Some(set.join(" "))
        }
    };
    match op {
        ClassOp::Add(tokens) => {
            tokens.iter().try_for_each(|t| check(t))?;
            for t in tokens {
                if !set.contains(t) {
                    set.push(t.clone());
                }
            }
            Ok((update(&set), false))
        }
        ClassOp::Remove(tokens) => {
            tokens.iter().try_for_each(|t| check(t))?;
            set.retain(|s| !tokens.contains(s));
            Ok((update(&set), false))
        }
        ClassOp::Toggle(t, force) => {
            check(t)?;
            if set.contains(t) {
                if *force == Some(true) {
                    return Ok((None, true));
                }
                set.retain(|s| s != t);
                Ok((update(&set), false))
            } else {
                if *force == Some(false) {
                    return Ok((None, false));
                }
                set.push(t.clone());
                Ok((update(&set), true))
            }
        }
        ClassOp::Contains(t) => Ok((None, set.contains(t))),
        ClassOp::Replace(t, new) => {
            check(t)?;
            check(new)?;
            if !set.contains(t) {
                return Ok((None, false));
            }
            // The ordered set's replace: the first instance of either
            // becomes the replacement, all other instances of either go.
            let first = set
                .iter()
                .position(|s| s == t || s == new)
                .expect("present");
            let mut out = vec![];
            for (i, s) in set.iter().enumerate() {
                if i == first {
                    out.push(new.clone());
                } else if s != t && s != new {
                    out.push(s.clone());
                }
            }
            Ok((update(&out), true))
        }
    }
}

/// The DOM standard's viable sibling for `before()` and `after()`: in
/// `siblings` (a parent's children, in order), from `at` moving by `step`
/// (exclusive), the first that is not one of `nodes`.
pub fn viable_sibling(siblings: &[u64], at: usize, forward: bool, nodes: &[u64]) -> Option<u64> {
    if forward {
        siblings[at + 1..]
            .iter()
            .copied()
            .find(|s| !nodes.contains(s))
    } else {
        siblings[..at]
            .iter()
            .rev()
            .copied()
            .find(|s| !nodes.contains(s))
    }
}

/// The nodes the HTML standard's `innerText` setter makes for `text`, in
/// order: `Some(text)` for a text node, `None` for a `<br>` element (one per
/// line break: CR LF, LF or CR). The empty string makes no nodes.
pub fn inner_text_parts(text: &str) -> Vec<Option<String>> {
    let mut out = vec![];
    let mut run = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                if !run.is_empty() {
                    out.push(Some(std::mem::take(&mut run)));
                }
                out.push(None);
            }
            c => run.push(c),
        }
    }
    if !run.is_empty() {
        out.push(Some(run));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inner_text_breaks_lines_into_br_elements() {
        assert_eq!(inner_text_parts(""), Vec::<Option<String>>::new());
        assert_eq!(inner_text_parts("a"), vec![Some("a".into())]);
        assert_eq!(
            inner_text_parts("a\nb\r\nc\rd"),
            vec![
                Some("a".into()),
                None,
                Some("b".into()),
                None,
                Some("c".into()),
                None,
                Some("d".into())
            ]
        );
        assert_eq!(inner_text_parts("\n\n"), vec![None, None]);
    }

    #[test]
    fn class_lists_follow_the_dom_standard() {
        let s = |v: &str| v.to_owned();
        // add normalizes the attribute; toggle with force true of a present
        // token does not run the update steps; an absent attribute stays so.
        assert_eq!(
            class_list(Some(" a  b a "), &ClassOp::Add(vec![s("c")])).unwrap(),
            (Some(s("a b c")), false)
        );
        assert_eq!(
            class_list(Some("a  b"), &ClassOp::Toggle(s("a"), Some(true))).unwrap(),
            (None, true)
        );
        assert_eq!(
            class_list(Some("a b"), &ClassOp::Toggle(s("a"), None)).unwrap(),
            (Some(s("b")), false)
        );
        assert_eq!(
            class_list(None, &ClassOp::Remove(vec![s("x")])).unwrap(),
            (None, false)
        );
        assert_eq!(
            class_list(Some(""), &ClassOp::Remove(vec![s("x")])).unwrap(),
            (Some(s("")), false)
        );
        assert_eq!(
            class_list(Some("a b c"), &ClassOp::Replace(s("a"), s("c"))).unwrap(),
            (Some(s("c b")), true)
        );
        assert_eq!(
            class_list(Some("a"), &ClassOp::Add(vec![s("")]))
                .unwrap_err()
                .0,
            "SyntaxError"
        );
        assert_eq!(
            class_list(Some("a"), &ClassOp::Add(vec![s("b c")]))
                .unwrap_err()
                .0,
            "InvalidCharacterError"
        );
        assert_eq!(viable_sibling(&[1, 2, 3, 4], 1, true, &[3]), Some(4));
        assert_eq!(viable_sibling(&[1, 2, 3, 4], 2, false, &[2, 1]), None);
    }
}
