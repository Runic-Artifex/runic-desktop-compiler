//! Lay an HTML file out with Blitz and print the border boxes of its
//! elements with an `id` as JSON lines, for comparing Blitz's layout of a
//! construct with Chromium's: `layout-probe <in.html> [width] [height]`.
use blitz_dom::{Document, DocumentConfig};
use blitz_html::HtmlDocument;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let html = std::fs::read_to_string(&args[1]).expect("input html");
    let width: u32 = args.get(2).and_then(|w| w.parse().ok()).unwrap_or(800);
    let height: u32 = args.get(3).and_then(|h| h.parse().ok()).unwrap_or(600);
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            net_provider: Some(blitz_shell::DataUriNetProvider::shared(None)),
            html_parser_provider: Some(std::sync::Arc::new(blitz_html::HtmlProvider)),
            viewport: Some(blitz_traits::shell::Viewport::new(
                width,
                height,
                1.0,
                blitz_traits::shell::ColorScheme::Light,
            )),
            ..Default::default()
        },
    );
    for _ in 0..4 {
        doc.inner_mut().resolve(0.0);
    }
    let inner = doc.inner();
    let mut stack = vec![inner.root_node().id];
    let mut found = vec![];
    while let Some(id) = stack.pop() {
        let node = inner.get_node(id).expect("node");
        if let Some(name) = node.attr(markup5ever::local_name!("id")) {
            let at = node.absolute_position(0.0, 0.0);
            let size = node.final_layout().size;
            found.push((
                id,
                serde_json::json!({ "id": name, "x": at.x, "y": at.y, "width": size.width, "height": size.height }),
            ));
        }
        stack.extend(node.children.iter().rev());
    }
    found.sort_by_key(|f| f.0);
    for (_, v) in found {
        println!("{v}");
    }
}
