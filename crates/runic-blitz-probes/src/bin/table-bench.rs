//! Release-only table layout costs; no rasterisation or framework work in the
//! timed mutations. Each sample starts from the same row count and markup.
use base64::Engine;
use blitz_dom::{Document, DocumentConfig};
use blitz_html::HtmlDocument;
use markup5ever::{LocalName, QualName, local_name, ns};
use serde_json::json;
use std::time::Instant;

fn stats(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    let n = samples.len();
    json!({"medianMs":samples[n / 2], "p95Ms":samples[((n as f64 * 0.95).ceil() as usize - 1).min(n - 1)]})
}
fn main() {
    assert!(!cfg!(debug_assertions), "run table-bench in release mode");
    let font = base64::engine::general_purpose::STANDARD.encode(include_bytes!(
        "../../../../fixtures/counter-svelte/assets/DejaVuSans.woff2"
    ));
    let mut results = Vec::new();
    for rows in [100, 1000] {
        let html = format!("<style>@font-face{{font-family:Test;src:url(data:font/woff2;base64,{font})}}body{{margin:0;font:16px/20px Test}}td{{padding:4px}}table{{width:100%;border-spacing:0}}</style><main id='pane' style='width:800px'><table><caption>Translations</caption><tbody id='body'>{}</tbody></table></main>",
            (0..rows).map(|i|format!("<tr><td id='cell{i}'>Key {i}</td><td>Translated label {i}</td><td>Ready</td></tr>")).collect::<String>());
        let mut timings = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for sample in 0..18 {
            let initial = Instant::now();
            let mut doc = HtmlDocument::from_html(
                &html,
                DocumentConfig {
                    viewport: Some(blitz_traits::shell::Viewport::new(
                        800,
                        600,
                        1.0,
                        blitz_traits::shell::ColorScheme::Light,
                    )),
                    net_provider: Some(blitz_shell::DataUriNetProvider::shared(None)),
                    html_parser_provider: Some(std::sync::Arc::new(blitz_html::HtmlProvider)),
                    ..Default::default()
                },
            );
            // Resource ingestion and the first settled table layout are part
            // of initial cost. Subsequent mutations need one resolve.
            for _ in 0..4 {
                doc.inner_mut().resolve(0.0);
            }
            let initial_ms = initial.elapsed().as_secs_f64() * 1000.0;
            let mut inner = doc.inner_mut();
            let cell = inner.query_selector("#cell0").unwrap().unwrap();
            let body = inner.query_selector("#body").unwrap().unwrap();
            let pane = inner.query_selector("#pane").unwrap().unwrap();
            let text = inner.get_node(cell).unwrap().children[0];
            assert!(
                inner
                    .get_node(cell)
                    .unwrap()
                    .element_data()
                    .unwrap()
                    .inline_layout_data
                    .as_ref()
                    .is_some_and(|inline| inline
                        .layout
                        .lines()
                        .any(|line| line.metrics().advance > 0.0)),
                "the embedded benchmark font must be loaded before timing mutations"
            );
            let start = Instant::now();
            inner
                .mutate()
                .set_node_text(text, "A longer translated label after editing");
            inner.resolve(0.0);
            let update_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let mut m = inner.mutate();
            let row = m.create_element(QualName::new(None, ns!(), local_name!("tr")), vec![]);
            for text in ["New key", "Inserted translation", "Ready"] {
                let cell = m.create_element(QualName::new(None, ns!(), local_name!("td")), vec![]);
                let text = m.create_text_node(text);
                m.append_children(cell, &[text]);
                m.append_children(row, &[cell]);
            }
            m.append_children(body, &[row]);
            drop(m);
            inner.resolve(0.0);
            let insert_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            inner.mutate().set_attribute(
                pane,
                QualName::new(None, ns!(), LocalName::from("style")),
                "width:420px",
            );
            inner.resolve(0.0);
            let resize_ms = start.elapsed().as_secs_f64() * 1000.0;
            if sample >= 3 {
                for (values, value) in timings
                    .iter_mut()
                    .zip([initial_ms, update_ms, insert_ms, resize_ms])
                {
                    values.push(value);
                }
            }
        }
        results.push(json!({"rows":rows,"initial":stats(timings[0].clone()),"cellUpdate":stats(timings[1].clone()),"rowInsertion":stats(timings[2].clone()),"parentResize":stats(timings[3].clone())}));
    }
    let memory = std::fs::read_to_string("/proc/self/status").unwrap();
    let memory: Vec<_> = memory
        .lines()
        .filter(|l| l.starts_with("VmRSS:") || l.starts_with("VmHWM:"))
        .collect();
    println!(
        "{}",
        json!({"samples":15,"warmup":3,"viewport":[800,600],"memory":memory,"results":results})
    );
}
