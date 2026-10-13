//! Script DOM decisions shared by the native runtime and the reference
//! interpreter (M6, docs/design/M6-SCRIPT-DOM.md), so that both build the
//! same nodes.

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
}
