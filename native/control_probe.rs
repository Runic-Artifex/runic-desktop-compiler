use blitz_dom::{DocGuard, DocGuardMut, Document, DocumentConfig, EventDriver, EventHandler};
use blitz_html::HtmlDocument;
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig};
use blitz_traits::{
    events::{DomEvent, DomEventData, EventState, UiEvent},
    node_id::NodeId,
};

struct Probe {
    doc: HtmlDocument,
}
struct Handler;
impl EventHandler for Handler {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        _: &mut EventState,
    ) {
        if matches!(
            event.data,
            DomEventData::Click(_)
                | DomEventData::KeyDown(_)
                | DomEventData::KeyUp(_)
                | DomEventData::Input(_)
        ) {
            let d = doc.inner();
            let target = chain
                .iter()
                .find_map(|&id| d.get_node(id).and_then(|n| n.attr("id".into())));
            println!("PROBE_EVENT {:?} target={target:?}", event.data);
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
    fn handle_ui_event(&mut self, e: UiEvent) {
        EventDriver::new(&mut self.doc, Handler).handle_ui_event(e);
    }
}
fn main() {
    let html = "<html><head><style>body{padding:32px;background:white;color:black;font-size:24px}select,button{font-size:24px;padding:12px;margin:12px;border:1px solid black}</style></head><body><p>Controlled select capability probe</p><select id='choice'><option value='basic'>Basic</option><option value='pro'>Pro</option></select><button id='after'>After select</button></body></html>";
    use base64::Engine;
    let font = base64::engine::general_purpose::STANDARD.encode(include_bytes!(
        "../fixtures/quantity/assets/DejaVuSans.woff2"
    ));
    let html=html.replace("<head>",&format!("<head><style>@font-face{{font-family:Probe;src:url(data:font/woff2;base64,{font}) format('woff2')}}body,select,button{{font-family:Probe}}</style>"));
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
    let event_loop = if std::env::args().any(|x| x == "--x11") {
        use winit::platform::x11::EventLoopBuilderExtX11;
        winit::event_loop::EventLoop::builder()
            .with_x11()
            .build()
            .unwrap()
    } else {
        blitz_shell::create_default_event_loop()
    };
    let (proxy, receiver) = BlitzShellProxy::new(event_loop.create_proxy());
    let mut app = BlitzApplication::new(proxy, receiver);
    app.add_window(WindowConfig::with_attributes(
        Box::new(Probe { doc }),
        anyrender_vello_cpu::VelloCpuWindowRenderer::new(),
        winit::window::WindowAttributes::default()
            .with_title("Runic select capability probe")
            .with_surface_size(winit::dpi::LogicalSize::new(600, 350)),
    ));
    event_loop.run_app(app).unwrap();
}
