//! Direct Blitz table oracle: render and observe before/after DOM mutations.
use anyrender::ImageRenderer;
use blitz_dom::{Document, DocumentConfig};
use blitz_html::HtmlDocument;
use markup5ever::{LocalName, QualName, local_name, ns};
use serde_json::{Map, Value, json};

fn observe(doc: &HtmlDocument) -> Value {
    let inner = doc.inner();
    let mut rects = Map::new();
    let mut hits = Map::new();
    let mut text_lines = Map::new();
    for id in inner.query_selector_all("[id]").unwrap() {
        let node = inner.get_node(id).unwrap();
        let name = node.attr(local_name!("id")).unwrap();
        let rect = inner.get_client_bounding_rect(id).unwrap();
        rects.insert(
            name.into(),
            json!([rect.x, rect.y, rect.width, rect.height]),
        );
        if let Some(inline) = node
            .element_data()
            .and_then(|el| el.inline_layout_data.as_ref())
        {
            let layout = node.final_layout();
            let lines: Vec<_> = inline.layout.lines().map(|line| {
                let metrics = line.metrics();
                json!({
                    "x": rect.x + (layout.border.left + layout.padding.left + metrics.offset) as f64,
                    "baseline": rect.y + (layout.border.top + layout.padding.top + metrics.baseline) as f64,
                    "advance": metrics.advance,
                    "hangingAdvance": metrics.hanging_advance,
                    "height": metrics.line_height,
                })
            }).collect();
            text_lines.insert(name.into(), json!(lines));
        }
        let mut targets = Vec::new();
        for (dx, dy) in [
            (rect.width / 2.0, rect.height / 2.0),
            (1.0, 1.0),
            (rect.width - 1.0, rect.height - 1.0),
        ] {
            let mut id = inner
                .hit((rect.x + dx) as f32, (rect.y + dy) as f32)
                .map(|hit| hit.node_id);
            let mut target = None;
            while let Some(current) = id {
                let node = inner.get_node(current).unwrap();
                if let Some(name) = node.attr(local_name!("id")) {
                    target = Some(name.to_string());
                    break;
                }
                id = node.parent;
            }
            targets.push(target);
        }
        hits.insert(name.into(), json!(targets));
    }
    json!({"rects":rects,"hits":hits,"textLines":text_lines})
}
fn render(doc: &mut HtmlDocument, path: &str, width: u32, height: u32) {
    let mut renderer = anyrender_vello_cpu::VelloCpuImageRenderer::new(width, height);
    let mut buffer = Vec::new();
    let mut inner = doc.inner_mut();
    renderer.render_to_vec(
        |scene| blitz_paint::paint_scene(scene, &mut inner, 1.0, width, height, 0, 0),
        &mut buffer,
    );
    let mut encoder = png::Encoder::new(std::fs::File::create(path).unwrap(), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&buffer)
        .unwrap();
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let html = std::fs::read_to_string(&args[1]).expect("input html");
    let width: u32 = args.get(3).and_then(|w| w.parse().ok()).unwrap_or(640);
    let height: u32 = args.get(4).and_then(|h| h.parse().ok()).unwrap_or(300);
    let actions: Vec<Value> = args
        .get(5)
        .map(|s| serde_json::from_str(s).unwrap())
        .unwrap_or_default();
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
    let mut observations = Vec::new();
    for step in 0..=actions.len() {
        if step > 0 {
            let action = &actions[step - 1];
            let selector = action["selector"].as_str().unwrap();
            let mut inner = doc.inner_mut();
            let id = inner.query_selector(selector).unwrap().unwrap();
            match action["kind"].as_str().unwrap() {
                "html" => inner
                    .mutate()
                    .set_inner_html(id, action["value"].as_str().unwrap()),
                "attribute" => inner.mutate().set_attribute(
                    id,
                    QualName::new(
                        None,
                        ns!(),
                        LocalName::from(action["name"].as_str().unwrap()),
                    ),
                    action["value"].as_str().unwrap(),
                ),
                _ => panic!("unknown table oracle action"),
            }
        }
        for _ in 0..4 {
            doc.inner_mut().resolve(0.0);
        }
        let filename = if step == 0 {
            args[2].clone()
        } else {
            args[2].replace(".png", &format!("-{step}.png"))
        };
        render(&mut doc, &filename, width, height);
        observations.push(observe(&doc));
    }
    println!("{}", json!(observations));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(markup: &str) -> HtmlDocument {
        let mut doc = HtmlDocument::from_html(
            &format!(
                "<style>body{{margin:0}}table{{border-spacing:2px}}td{{padding:0}}</style>{markup}"
            ),
            DocumentConfig {
                viewport: Some(blitz_traits::shell::Viewport::new(
                    640,
                    300,
                    1.0,
                    blitz_traits::shell::ColorScheme::Light,
                )),
                html_parser_provider: Some(std::sync::Arc::new(blitz_html::HtmlProvider)),
                ..Default::default()
            },
        );
        doc.resolve(0.0);
        doc
    }
    fn rect(doc: &HtmlDocument, selector: &str) -> [f64; 4] {
        let inner = doc.inner();
        let id = inner.query_selector(selector).unwrap().unwrap();
        let r = inner.get_client_bounding_rect(id).unwrap();
        [r.x, r.y, r.width, r.height]
    }
    const ROW: &str = "<tbody id='group'><tr id='row'><td id='a'><div id='inside' style='width:30px;height:20px'></div></td><td id='b'><div style='width:90px;height:40px'></div></td></tr></tbody>";
    #[test]
    fn auto_columns_and_internal_boxes() {
        let doc = document(&format!("<table id='table'>{ROW}</table>"));
        assert_eq!(rect(&doc, "#table"), [0.0, 0.0, 126.0, 44.0]);
        assert_eq!(rect(&doc, "#group"), [2.0, 2.0, 122.0, 40.0]);
        assert_eq!(rect(&doc, "#row"), [2.0, 2.0, 122.0, 40.0]);
        assert_eq!(rect(&doc, "#inside"), [2.0, 12.0, 30.0, 20.0]);
        let inner = doc.inner();
        let hit = inner.hit(10.0, 20.0).unwrap();
        let row = inner.query_selector("#row").unwrap().unwrap();
        let mut current = Some(hit.node_id);
        let mut has_row = false;
        while let Some(id) = current {
            has_row |= id == row;
            current = inner.get_node(id).unwrap().parent;
        }
        assert!(
            has_row,
            "row click must target a descendant and bubble through the row"
        );
    }
    #[test]
    fn caption_is_outside_the_grid_box() {
        let doc = document(&format!(
            "<table id='table'><caption id='caption' style='height:10px'></caption>{ROW}</table><div id='after'></div>"
        ));
        assert_eq!(rect(&doc, "#caption"), [0.0, 0.0, 126.0, 10.0]);
        assert_eq!(rect(&doc, "#row"), [2.0, 12.0, 122.0, 40.0]);
        assert_eq!(rect(&doc, "#table"), [0.0, 0.0, 126.0, 54.0]);
        assert_eq!(rect(&doc, "#after")[1], 54.0);
    }
    #[test]
    fn updates_recompute_width_and_do_not_accumulate_alignment_offsets() {
        let mut doc = document(&format!("<table id='table'>{ROW}</table>"));
        for _ in 0..3 {
            let mut inner = doc.inner_mut();
            let id = inner.query_selector("#inside").unwrap().unwrap();
            inner.mutate().set_attribute(
                id,
                QualName::new(None, ns!(), local_name!("style")),
                "width:60px;height:20px",
            );
            drop(inner);
            doc.resolve(0.0);
            assert_eq!(rect(&doc, "#table"), [0.0, 0.0, 156.0, 44.0]);
            assert_eq!(rect(&doc, "#inside"), [2.0, 12.0, 60.0, 20.0]);
        }
    }
    #[test]
    fn rtl_rows_keep_positive_boxes() {
        let doc = document(&format!("<table id='table' dir='rtl'>{ROW}</table>"));
        assert_eq!(rect(&doc, "#row"), [2.0, 2.0, 122.0, 40.0]);
        assert_eq!(rect(&doc, "#a"), [94.0, 2.0, 30.0, 40.0]);
        assert_eq!(rect(&doc, "#b"), [2.0, 2.0, 90.0, 40.0]);
    }
    #[test]
    fn cell_height_is_a_border_box_minimum_and_content_can_grow_it() {
        let mut doc = document(&format!(
            "<style>#a{{height:60px;padding:5px;border:2px solid}}</style><table>{ROW}</table>"
        ));
        assert_eq!(rect(&doc, "#row")[3], 60.0);
        assert_eq!(rect(&doc, "#inside")[1], 22.0);
        let mut inner = doc.inner_mut();
        let id = inner.query_selector("#a").unwrap().unwrap();
        inner.mutate().set_attribute(
            id,
            QualName::new(None, ns!(), local_name!("style")),
            "height:10px",
        );
        drop(inner);
        doc.resolve(0.0);
        assert_eq!(rect(&doc, "#row")[3], 40.0);
        assert_eq!(rect(&doc, "#inside")[1], 12.0);
    }
    #[test]
    fn percentage_cell_height_reserves_space_but_content_can_grow_it() {
        let mut doc = document(
            "<table id='table' style='height:160px'><tr id='row'><td id='a' style='height:50%;padding:4px;border:2px solid'><div id='inside' style='width:30px;height:10px'></div></td></tr><tr id='row2'><td style='padding:4px'><div style='width:30px;height:10px'></div></td></tr></table>",
        );
        assert_eq!(rect(&doc, "#row")[3], 78.0);
        assert_eq!(rect(&doc, "#row2")[3], 76.0);
        let mut inner = doc.inner_mut();
        let id = inner.query_selector("#inside").unwrap().unwrap();
        inner.mutate().set_attribute(
            id,
            QualName::new(None, ns!(), local_name!("style")),
            "width:30px;height:120px",
        );
        drop(inner);
        doc.resolve(0.0);
        assert_eq!(rect(&doc, "#row")[3], 132.0);
        assert_eq!(rect(&doc, "#row2")[3], 22.0);
        let mut inner = doc.inner_mut();
        let id = inner.query_selector("#table").unwrap().unwrap();
        inner.mutate().set_attribute(
            id,
            QualName::new(None, ns!(), local_name!("style")),
            "height:auto",
        );
        drop(inner);
        doc.resolve(0.0);
        assert_eq!(rect(&doc, "#row")[3], 132.0);
        assert_eq!(rect(&doc, "#row2")[3], 18.0);
        assert_eq!(rect(&doc, "#table")[3], 156.0);
    }
}
