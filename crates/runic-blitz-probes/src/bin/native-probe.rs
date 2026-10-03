use blitz_dom::{DocGuard, DocGuardMut, Document, DocumentConfig};
use blitz_dom::{EventDriver, EventHandler};
use blitz_html::HtmlDocument;
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig, create_default_event_loop};
use blitz_traits::{
    events::{DomEvent, DomEventData, EventState, UiEvent},
    node_id::NodeId,
};

struct Probe {
    doc: HtmlDocument,
    count: i64,
}
struct Handler<'a>(&'a mut i64);
impl EventHandler for Handler<'_> {
    fn handle_event(
        &mut self,
        _: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        state: &mut EventState,
    ) {
        if matches!(event.data, DomEventData::Click(_)) {
            *self.0 += 1;
            let mut doc = doc.inner_mut();
            let id = doc.query_selector("#value").unwrap().unwrap();
            doc.mutate()
                .set_inner_html(id, &format!("Native clicks: {}", self.0));
            println!("REAL_NATIVE_CLICK {}", self.0);
            state.request_redraw();
        }
    }
}
impl Document for Probe {
    fn inner(&self) -> DocGuard<'_> {
        self.doc.inner()
    }
    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        self.doc.inner_mut()
    }
    fn handle_ui_event(&mut self, event: UiEvent) {
        EventDriver::new(&mut self.doc, Handler(&mut self.count)).handle_ui_event(event);
    }
}
fn main() {
    use base64::Engine;
    let font = base64::engine::general_purpose::STANDARD.encode(include_bytes!(
        "../../../../fixtures/quantity/assets/DejaVuSans.woff2"
    ));
    let html = format!(
        "<html><head><style>@font-face{{font-family:Fixture;src:url(data:font/woff2;base64,{font}) format('woff2')}}body{{background:#ece6d8;padding:40px;font-size:24px}}button{{padding:20px;font-family:Fixture;font-size:24px}}</style></head><body><button id='value'>Native clicks: 0</button></body></html>"
    );
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            net_provider: Some(blitz_shell::DataUriNetProvider::shared(None)),
            html_parser_provider: Some(std::sync::Arc::new(blitz_html::HtmlProvider)),
            ..Default::default()
        },
    );
    for _ in 0..4 {
        doc.resolve(0.0);
    }
    let event_loop = if std::env::args().any(|a| a == "--x11") {
        use winit::platform::x11::EventLoopBuilderExtX11;
        winit::event_loop::EventLoop::builder()
            .with_x11()
            .build()
            .unwrap()
    } else {
        create_default_event_loop()
    };
    let (proxy, receiver) = BlitzShellProxy::new(event_loop.create_proxy());
    let mut app = BlitzApplication::new(proxy, receiver);
    app.add_window(WindowConfig::with_attributes(
        Box::new(Probe { doc, count: 0 }),
        anyrender_vello_cpu::VelloCpuWindowRenderer::new(),
        winit::window::WindowAttributes::default()
            .with_title("Runic native input probe")
            .with_surface_size(winit::dpi::LogicalSize::new(640, 480)),
    ));
    event_loop.run_app(app).unwrap();
}
