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
    let mut scroll = Map::new();
    let mut editors = Map::new();
    let mut line_widths = Map::new();
    // Device-space layout metrics are diagnostic evidence for native text
    // rasterization. They are deliberately separate from `textLines`, whose
    // CSS-space geometry is compared with the browser oracle.
    let mut layout_metrics = Map::new();
    for id in inner.query_selector_all("[id]").unwrap() {
        let node = inner.get_node(id).unwrap();
        let name = node.attr(local_name!("id")).unwrap();
        let rect = inner.get_transformed_client_bounding_rect(id).unwrap();
        if node.attr(LocalName::from("data-line-widths")).is_some() {
            let style = node.primary_styles().unwrap();
            let zoom = style.effective_zoom;
            let resolved = |width: f32, hidden: bool| {
                if hidden { 0.0 } else { zoom.unzoom(width) }
            };
            line_widths.insert(
                name.into(),
                json!([
                    resolved(
                        style.clone_border_top_width().0.to_f32_px(),
                        style.clone_border_top_style().none_or_hidden()
                    ),
                    resolved(
                        style.clone_border_right_width().0.to_f32_px(),
                        style.clone_border_right_style().none_or_hidden()
                    ),
                    resolved(
                        style.clone_border_bottom_width().0.to_f32_px(),
                        style.clone_border_bottom_style().none_or_hidden()
                    ),
                    resolved(
                        style.clone_border_left_width().0.to_f32_px(),
                        style.clone_border_left_style().none_or_hidden()
                    ),
                    resolved(
                        style.clone_outline_width().0.to_f32_px(),
                        style.clone_outline_style().none_or_hidden()
                    ),
                ]),
            );
        }
        let mut node_layout_metrics = Map::new();
        if node.attr(LocalName::from("data-scroll")).is_some() {
            scroll.insert(
                name.into(),
                json!([
                    node.scroll_position().x,
                    node.scroll_position().y,
                    node.scroll_width().round(),
                    node.scroll_height().round(),
                    node.client_width().round(),
                    node.client_height().round(),
                ]),
            );
        }
        rects.insert(
            name.into(),
            json!([rect.x, rect.y, rect.width, rect.height]),
        );
        if let Some(input) = node.element_data().and_then(|e| e.text_input_data()) {
            let text = input.editor.raw_text();
            let range = input.editor.raw_selection().text_range();
            editors.insert(
                name.into(),
                json!([
                    text,
                    text[..range.start].encode_utf16().count(),
                    text[..range.end].encode_utf16().count(),
                    node.is_focussed()
                ]),
            );
            if let Some(layout) = input.editor.try_layout() {
                let first = layout.lines().next().map(|line| {
                    let metrics = line.metrics();
                    json!({"baseline": metrics.baseline, "height": metrics.line_height})
                });
                let last = layout.lines().last().map(|line| {
                    let metrics = line.metrics();
                    json!({"baseline": metrics.baseline, "height": metrics.line_height})
                });
                node_layout_metrics.insert(
                    "editor".into(),
                    json!({
                        "scale": layout.scale(),
                        "first": first,
                        "last": last,
                    }),
                );
            }
        }
        if let Some(inline) = node
            .element_data()
            .and_then(|el| el.inline_layout_data.as_ref())
        {
            let layout = node.final_layout();
            let scale = inner.viewport().scale();
            let lines: Vec<_> = inline.layout.lines().map(|line| {
                let metrics = line.metrics();
                json!({
                    "x": rect.x + (layout.border.left + layout.padding.left + metrics.offset / scale) as f64,
                    "baseline": rect.y + (layout.border.top + layout.padding.top + metrics.baseline / scale) as f64,
                    "advance": metrics.advance / scale,
                    "hangingAdvance": metrics.hanging_advance / scale,
                    "height": metrics.line_height / scale,
                })
            }).collect();
            text_lines.insert(name.into(), json!(lines));
            let first = inline.layout.lines().next().map(|line| {
                let metrics = line.metrics();
                json!({"baseline": metrics.baseline, "height": metrics.line_height})
            });
            let last = inline.layout.lines().last().map(|line| {
                let metrics = line.metrics();
                json!({"baseline": metrics.baseline, "height": metrics.line_height})
            });
            node_layout_metrics.insert(
                "inline".into(),
                json!({
                    "scale": inline.layout.scale(),
                    "first": first,
                    "last": last,
                }),
            );
        }
        if !node_layout_metrics.is_empty() {
            layout_metrics.insert(name.into(), Value::Object(node_layout_metrics));
        }
        let mut targets = Vec::new();
        for (dx, dy) in [
            (rect.width / 2.0, rect.height / 2.0),
            (1.0, 1.0),
            (rect.width - 1.0, rect.height - 1.0),
        ] {
            let point = (rect.x + dx, rect.y + dy);
            let viewport = inner.viewport();
            let in_view = point.0 >= 0.0
                && point.1 >= 0.0
                && point.0 < f64::from(viewport.window_size.0) / viewport.scale_f64()
                && point.1 < f64::from(viewport.window_size.1) / viewport.scale_f64();
            let mut id = in_view
                .then(|| {
                    inner.hit(
                        (point.0 + inner.viewport_scroll().x) as f32,
                        (point.1 + inner.viewport_scroll().y) as f32,
                    )
                })
                .flatten()
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
    json!({"rects":rects,"hits":hits,"textLines":text_lines,"scroll":scroll,"editors":editors,"layoutMetrics":layout_metrics,"lineWidths":line_widths})
}
fn render(doc: &mut HtmlDocument, path: &str, width: u32, height: u32) {
    let mut renderer = anyrender_vello_cpu::VelloCpuImageRenderer::new(width, height);
    let mut buffer = Vec::new();
    let mut inner = doc.inner_mut();
    let scale = inner.viewport().scale_f64();
    renderer.render_to_vec(
        |scene| blitz_paint::paint_scene(scene, &mut inner, scale, width, height, 0, 0),
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
    let dpr: f32 = args.get(6).and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let width = (width as f32 * dpr).round() as u32;
    let height = (height as f32 * dpr).round() as u32;
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
                dpr,
                blitz_traits::shell::ColorScheme::Light,
            )),
            ..Default::default()
        },
    );
    let mut observations = Vec::new();
    let mut clock = 0.0;
    for step in 0..=actions.len() {
        if step > 0 {
            let action = &actions[step - 1];
            clock = action["at"].as_f64().map_or(clock, |ms| ms / 1000.0);
            let selector = action["selector"].as_str().unwrap_or("html");
            let mut inner = doc.inner_mut();
            let id = inner.query_selector(selector).unwrap().unwrap();
            match action["kind"].as_str().unwrap() {
                "time" | "observe" => {}
                "style" => inner.mutate().set_attribute(
                    id,
                    QualName::new(None, ns!(), local_name!("style")),
                    action["value"].as_str().unwrap(),
                ),
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
                "scroll" => inner.scroll_to(
                    id,
                    action["x"].as_f64().unwrap_or(0.0),
                    action["y"].as_f64().unwrap_or(0.0),
                    blitz_dom::ScrollBehavior::Instant,
                ),
                "focus" => {
                    inner.set_focus_to(id);
                }
                "pointerDown" | "pointerMove" | "pointerUp" => {
                    use blitz_traits::events::{MouseEventButton, MouseEventButtons, UiEvent};
                    let node = inner.get_node(id).unwrap();
                    let rect = inner.get_transformed_client_bounding_rect(id).unwrap();
                    let x = (rect.x + action["x"].as_f64().unwrap()) as f32;
                    let y = (rect.y + action["y"].as_f64().unwrap()) as f32;
                    let mut event = node.synthetic_click_event_data(Default::default());
                    event.coords.page_x = x;
                    event.coords.client_x = x;
                    event.coords.screen_x = x;
                    event.coords.page_y = y;
                    event.coords.client_y = y;
                    event.coords.screen_y = y;
                    event.button = MouseEventButton::Main;
                    event.buttons = if action["kind"] == "pointerUp" {
                        MouseEventButtons::None
                    } else {
                        MouseEventButtons::Primary
                    };
                    let event = match action["kind"].as_str().unwrap() {
                        "pointerDown" => UiEvent::PointerDown(event),
                        "pointerMove" => UiEvent::PointerMove(event),
                        _ => UiEvent::PointerUp(event),
                    };
                    drop(inner);
                    doc.handle_ui_event(event);
                }
                "selection" => {
                    let text = inner
                        .get_node(id)
                        .unwrap()
                        .element_data()
                        .unwrap()
                        .text_input_data()
                        .unwrap()
                        .editor
                        .raw_text();
                    let byte_at = |units: usize| {
                        let mut offset = 0;
                        for (byte, ch) in text.char_indices() {
                            if offset == units {
                                return byte;
                            }
                            offset += ch.len_utf16();
                            assert!(
                                offset <= units,
                                "oracle selections must use UTF-16 character boundaries"
                            );
                        }
                        text.len()
                    };
                    let end = action["end"].as_u64().unwrap() as usize;
                    let start = (action["start"].as_u64().unwrap() as usize).min(end);
                    let (start, end) = (byte_at(start), byte_at(end));
                    inner.with_text_input(id, |mut driver| driver.select_byte_range(start, end));
                }
                "scrollIntoView" => inner.scroll_into_view(
                    id,
                    blitz_dom::ScrollBehavior::Instant,
                    match action["block"].as_str() {
                        Some("start") => blitz_dom::ScrollLogicalPosition::Start,
                        Some("end") => blitz_dom::ScrollLogicalPosition::End,
                        Some("center") => blitz_dom::ScrollLogicalPosition::Center,
                        _ => blitz_dom::ScrollLogicalPosition::Nearest,
                    },
                    match action["inline"].as_str() {
                        Some("start") => blitz_dom::ScrollLogicalPosition::Start,
                        Some("end") => blitz_dom::ScrollLogicalPosition::End,
                        Some("center") => blitz_dom::ScrollLogicalPosition::Center,
                        _ => blitz_dom::ScrollLogicalPosition::Nearest,
                    },
                ),
                _ => panic!("unknown table oracle action"),
            }
        }
        for _ in 0..4 {
            doc.inner_mut().resolve(clock);
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
    #[test]
    fn css_line_widths_survive_device_rebuilds_and_pre_app_unit_thresholds() {
        let mut doc = document(
            "<div id='box' data-line-widths style='width:30px;height:20px;border-style:solid;border-width:.001px 1.999px 2.999px .5px;outline:1.999px solid'></div>",
        );
        for scale in [1.0, 1.25, 1.5, 2.0, 1.0] {
            doc.inner_mut()
                .set_viewport(blitz_traits::shell::Viewport::new(
                    (640.0 * scale) as u32,
                    (300.0 * scale) as u32,
                    scale,
                    blitz_traits::shell::ColorScheme::Light,
                ));
            for _ in 0..4 {
                doc.inner_mut().resolve(0.0);
            }
            let observed = observe(&doc);
            assert_eq!(observed["lineWidths"]["box"], json!([1, 1, 2, 1, 1]));
            assert_eq!(observed["rects"]["box"][2], json!(32.0));
            assert_eq!(observed["rects"]["box"][3], json!(23.0));
            // A physical hairline remains a device pixel, independently of line widths.
            assert_eq!(
                doc.inner_mut()
                    .stylist_device()
                    .app_units_per_device_pixel(),
                (60.0 / scale) as i32
            );
        }
    }

    #[test]
    fn logical_text_metrics_survive_viewport_scale_changes() {
        use base64::Engine;
        let font = base64::engine::general_purpose::STANDARD.encode(include_bytes!(
            "../../../../fixtures/counter-svelte/assets/DejaVuSans.woff2"
        ));
        let mut doc = HtmlDocument::from_html(
            &format!(
                "<!doctype html><style>@font-face{{font-family:Test;src:url(data:font/woff2;base64,{font})}}body{{margin:0;font:16px/20px Test}}#line{{white-space:pre}}textarea{{font:16px/20px Test;width:200px;height:60px}}</style><div id='line'>Alpha\nBeta</div><textarea id='editor'>Alpha\nBeta</textarea>"
            ),
            DocumentConfig {
                net_provider: Some(blitz_shell::DataUriNetProvider::shared(None)),
                html_parser_provider: Some(std::sync::Arc::new(blitz_html::HtmlProvider)),
                ..Default::default()
            },
        );
        for scale in [1.0, 1.25, 2.0, 1.0] {
            doc.inner_mut()
                .set_viewport(blitz_traits::shell::Viewport::new(
                    (640.0 * scale) as u32,
                    (300.0 * scale) as u32,
                    scale,
                    blitz_traits::shell::ColorScheme::Light,
                ));
            for _ in 0..4 {
                doc.inner_mut().resolve(0.0);
            }
            let observed = observe(&doc);
            for (id, kind) in [("line", "inline"), ("editor", "editor")] {
                let metrics = &observed["layoutMetrics"][id][kind];
                assert_eq!(metrics["scale"].as_f64(), Some(scale as f64));
                assert_eq!(
                    metrics["first"]["baseline"].as_f64(),
                    Some(15.0 * scale as f64)
                );
                assert_eq!(
                    metrics["last"]["baseline"].as_f64(),
                    Some(35.0 * scale as f64)
                );
                assert_eq!(
                    metrics["first"]["height"].as_f64(),
                    Some(20.0 * scale as f64)
                );
            }
            assert_eq!(
                observed["editors"]["editor"],
                json!(["Alpha\nBeta", 0, 0, false])
            );
        }
    }

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
    fn sticky_scroll_geometry_hits_and_layout_clamping() {
        let mut doc = document(
            "<div id='pane' style='width:200px;height:80px;overflow:auto;scrollbar-width:none'><section id='section' style='height:240px'><div style='height:30px'></div><div id='sticky' style='position:sticky;top:6px;height:20px;background:blue'></div></section></div>",
        );
        let mut inner = doc.inner_mut();
        let pane = inner.query_selector("#pane").unwrap().unwrap();
        let sticky = inner.query_selector("#sticky").unwrap().unwrap();
        inner.scroll_to(pane, 0.0, 60.0, blitz_dom::ScrollBehavior::Instant);
        inner.resolve(0.0);
        assert_eq!(inner.get_client_bounding_rect(pane).unwrap().y, 0.0);
        assert_eq!(inner.get_client_bounding_rect(sticky).unwrap().y, 6.0);
        assert_eq!(inner.hit(5.0, 10.0).unwrap().node_id, sticky);
        let section = inner.query_selector("#section").unwrap().unwrap();
        inner.mutate().set_attribute(
            section,
            QualName::new(None, ns!(), local_name!("style")),
            "height:40px",
        );
        inner.resolve(0.0);
        assert_eq!(inner.get_node(pane).unwrap().scroll_position().y, 0.0);
    }

    #[test]
    fn sibling_growth_anchors_visible_content_and_respects_opt_out() {
        for opt_out in [false, true] {
            let mut doc = document(&format!(
                "<div id='pane' style='width:200px;height:80px;overflow:auto;scrollbar-width:none;{}'><div id='before' style='height:60px'></div><div style='height:300px'></div></div>",
                if opt_out { "overflow-anchor:none" } else { "" }
            ));
            let mut inner = doc.inner_mut();
            let pane = inner.query_selector("#pane").unwrap().unwrap();
            let before = inner.query_selector("#before").unwrap().unwrap();
            inner.scroll_to(pane, 0.0, 100.0, blitz_dom::ScrollBehavior::Instant);
            inner.mutate().set_attribute(
                before,
                QualName::new(None, ns!(), local_name!("style")),
                "height:100px",
            );
            inner.resolve(0.0);
            assert_eq!(
                inner.get_node(pane).unwrap().scroll_position().y,
                if opt_out { 100.0 } else { 140.0 }
            );
        }
    }
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
