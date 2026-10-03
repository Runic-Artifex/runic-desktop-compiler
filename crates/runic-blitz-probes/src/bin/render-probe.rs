//! Render an HTML file with Blitz to a PNG (CPU renderer), for comparing
//! Blitz's rendering of a construct with Chromium's:
//! `render-probe <in.html> <out.png> [width] [height]`.
use anyrender::ImageRenderer;
use blitz_dom::{Document, DocumentConfig};
use blitz_html::HtmlDocument;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let html = std::fs::read_to_string(&args[1]).expect("input html");
    let width: u32 = args.get(3).and_then(|w| w.parse().ok()).unwrap_or(320);
    let height: u32 = args.get(4).and_then(|h| h.parse().ok()).unwrap_or(160);
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
    let mut renderer = anyrender_vello_cpu::VelloCpuImageRenderer::new(width, height);
    let mut buffer = Vec::new();
    let mut inner = doc.inner_mut();
    renderer.render_to_vec(
        |scene| blitz_paint::paint_scene(scene, &mut inner, 1.0, width, height, 0, 0),
        &mut buffer,
    );
    let file = std::fs::File::create(&args[2]).expect("output");
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&buffer)
        .unwrap();
}
