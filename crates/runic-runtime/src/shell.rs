//! Document construction and the desktop window.

use crate::App;
use crate::dom::{Dom, Listeners};
use crate::events::Native;
use anyrender::WindowRenderer;
use base64::Engine as _;
use blitz_dom::{BaseDocument, DocumentConfig, LocalName, Namespace, QualName, ns};
use blitz_shell::{BlitzApplication, BlitzShellProxy, DataUriNetProvider, WindowConfig};
use blitz_traits::node_id::NodeId;
use blitz_traits::shell::{ColorScheme, Viewport};
use std::sync::Arc;
use std::time::Instant;

#[cfg(feature = "renderer-cpu")]
pub(crate) type Renderer = anyrender_vello_cpu::VelloCpuWindowRenderer;
#[cfg(all(feature = "renderer-gpu", not(feature = "renderer-cpu")))]
pub(crate) type Renderer = anyrender_vello::VelloWindowRenderer;

/// The GPU renderer's anti-aliasing, for the window and probe screenshots
/// alike: area coverage, as the CPU renderer and Skia compute it, rather than
/// `anyrender_vello`'s default for windows, 16x MSAA, which differs more from
/// Chromium (`icons`: 0.27/255 against 0.11/255 per viewport; research doc,
/// GPU section).
#[cfg(all(feature = "renderer-gpu", not(feature = "renderer-cpu")))]
pub(crate) fn gpu_antialiasing() -> anyrender_vello::AaConfig {
    anyrender_vello::AaConfig::Area
}

fn window_renderer() -> Renderer {
    #[cfg(all(feature = "renderer-gpu", not(feature = "renderer-cpu")))]
    return Renderer::with_options(
        anyrender_vello::VelloRendererOptions::default().antialiasing_method(gpu_antialiasing()),
    );
    #[cfg(feature = "renderer-cpu")]
    Renderer::new()
}

/// Chromium's form-control defaults where Blitz's UA stylesheet differs: the
/// control font size and radio button metrics (the fork paints checkbox and
/// radio colours as Chromium does).
const UA_PARITY: &str = "input, textarea, select, button { font-size: 13.333333px; }\n\
input[type=radio] { margin: 3px 3px 0 5px; width: 13px; height: 13px; box-sizing: border-box; }\n\
svg { overflow: hidden; }";

/// Probe screenshots hide the caret, as the browser harness does.
#[cfg(feature = "probe")]
const PROBE_UA: &str = "* { caret-color: transparent !important; }";

/// The application stylesheet with `runic-asset:N` resolved to data URLs.
fn stylesheet<A: App>() -> String {
    let mut css = A::CSS.to_owned();
    // Replace higher indices first so `runic-asset:1` never matches `runic-asset:10`.
    for (i, (mime, bytes)) in A::ASSETS.iter().enumerate().rev() {
        let url = format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        css = css.replace(&format!("runic-asset:{i}"), &url);
    }
    css
}

fn element(doc: &mut BaseDocument, tag: &str, attrs: &[(&str, &str)]) -> NodeId {
    let attrs = attrs
        .iter()
        .map(|(k, v)| blitz_dom::Attribute {
            name: QualName::new(None, Namespace::from(""), LocalName::from(*k)),
            value: (*v).into(),
        })
        .collect();
    doc.mutate()
        .create_element(QualName::new(None, ns!(html), LocalName::from(tag)), attrs)
}

/// Build `<html><head><style/></head><body><div id="root">app</div></body></html>`
/// (the body and container attributes of the app's HTML template, M6)
/// without parsing HTML, mount the application and settle fonts and layout.
pub(crate) fn document<A: App>(width: u32, height: u32) -> Native<A> {
    // Scrollers a previous document's layout clamped (a probe's reload).
    crate::layout::take_clamped();
    // The animations of this document, if the program reads them (M6).
    crate::animations::reset(A::TRACKS_ANIMATIONS);
    // Rejections a previous document left unreported go with it.
    runic_js::clear_rejections();
    let mut doc = BaseDocument::new(DocumentConfig {
        net_provider: Some(DataUriNetProvider::shared(None)),
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        ..Default::default()
    });
    // Chromium user-agent defaults that Blitz's stylesheet lacks at the pinned
    // revision (form controls use `font: -webkit-small-control`).
    doc.add_user_agent_stylesheet(UA_PARITY);
    doc.add_user_agent_stylesheet(crate::select::UA);
    #[cfg(feature = "probe")]
    doc.add_user_agent_stylesheet(PROBE_UA);
    let root = doc.root_node().id;
    let html = element(&mut doc, "html", &[]);
    let head = element(&mut doc, "head", &[]);
    let style = element(&mut doc, "style", &[]);
    let title = element(&mut doc, "title", &[]);
    let body = element(&mut doc, "body", A::BODY_ATTRS);
    let mount = element(
        &mut doc,
        "div",
        A::CONTAINER_ATTRS.unwrap_or(&[("id", "root")]),
    );
    {
        let mut m = doc.mutate();
        let css = m.create_text_node(&stylesheet::<A>());
        m.append_children(style, &[css]);
        let title_text = m.create_text_node(A::TITLE);
        m.append_children(title, &[title_text]);
        m.append_children(head, &[title, style]);
        m.append_children(body, &[mount]);
        m.append_children(html, &[head, body]);
        m.append_children(root, &[html]);
    }
    // Media queries evaluated while the app starts see this viewport.
    crate::set_media_viewport(width as f64, height as f64);
    // The document loads at the session history's current entry.
    crate::history::begin_document();
    let mut app = A::new();
    let mut listeners = Listeners::default();
    listeners.container = Some(mount);
    listeners.body = Some(body);
    app.mount(
        &mut Dom {
            doc: &mut doc,
            listeners: &mut listeners,
        },
        mount,
    );
    // Fonts arrive through the net provider and register on resolve.
    for _ in 0..4 {
        crate::timeline::resolve(&mut doc);
    }
    listeners.settle(&mut doc);
    let mut native = Native {
        doc,
        app,
        listeners,
        space_target: None,
        nav_start: None,
        pointer: Default::default(),
        log: vec![],
        started: Instant::now(),
        wake_at: None,
        waker: None,
        fixup: None,
    };
    // Loaded: then the host's work queued while the app mounted.
    crate::history::loaded();
    native.host_tasks();
    crate::timeline::resolve(&mut native.doc);
    native.listeners.settle(&mut native.doc);
    native
}

/// Wraps the window renderer to report the time to first presented frame.
struct Measured {
    inner: Renderer,
    start: Instant,
    first: bool,
    size: (u32, u32),
}

impl anyrender::RenderContext for Measured {}

impl WindowRenderer for Measured {
    type ScenePainter<'a> = <Renderer as WindowRenderer>::ScenePainter<'a>;
    fn resume<F: FnOnce() + 'static>(
        &mut self,
        window: Arc<dyn anyrender::WindowHandle>,
        w: u32,
        h: u32,
        f: F,
    ) {
        self.size = (w, h);
        self.inner.resume(window, w, h, f);
    }
    fn complete_resume(&mut self) -> bool {
        self.inner.complete_resume()
    }
    fn suspend(&mut self) {
        self.inner.suspend();
    }
    fn is_active(&self) -> bool {
        self.inner.is_active()
    }
    fn set_size(&mut self, w: u32, h: u32) {
        self.size = (w, h);
        self.inner.set_size(w, h);
    }
    fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, f: F) {
        let (w, h) = self.size;
        self.inner.render(|scene| {
            canvas(scene, w, h);
            f(scene);
        });
        if !self.first {
            self.first = true;
            if std::env::var_os("RUNIC_EXIT_AFTER_FIRST_FRAME").is_some() {
                eprintln!(
                    "RUNIC_FIRST_FRAME_US {}",
                    self.start.elapsed().as_secs_f64() * 1e6
                );
                std::process::exit(0);
            }
        }
    }
}

/// Paint the initial canvas background (white, as in browsers) beneath the
/// document; Blitz leaves areas without a background transparent.
pub(crate) fn canvas<S: anyrender::PaintScene>(scene: &mut S, width: u32, height: u32) {
    scene.fill(
        peniko::Fill::NonZero,
        kurbo::Affine::IDENTITY,
        peniko::Color::WHITE,
        None,
        &kurbo::Rect::new(0.0, 0.0, f64::from(width), f64::from(height)),
    );
}

fn arg_value(args: &[String], name: &str) -> Option<u32> {
    args.windows(2)
        .find(|w| w[0] == name)
        .and_then(|w| w[1].parse().ok())
}

pub(crate) fn run<A: App>() {
    let start = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let width = arg_value(&args, "--width").unwrap_or(800);
    let height = arg_value(&args, "--height").unwrap_or(600);
    let native = document::<A>(width, height);
    let event_loop = if args.iter().any(|a| a == "--x11") {
        use winit::platform::x11::EventLoopBuilderExtX11;
        winit::event_loop::EventLoop::builder()
            .with_x11()
            .build()
            .expect("X11 event loop")
    } else {
        blitz_shell::create_default_event_loop()
    };
    let (proxy, receiver) = BlitzShellProxy::new(event_loop.create_proxy());
    let mut application = BlitzApplication::new(proxy, receiver);
    application.add_window(WindowConfig::with_attributes(
        Box::new(native),
        Measured {
            inner: window_renderer(),
            start,
            first: false,
            size: (width, height),
        },
        winit::window::WindowAttributes::default()
            .with_title(A::TITLE)
            .with_surface_size(winit::dpi::LogicalSize::new(width, height)),
    ));
    event_loop.run_app(application).expect("event loop");
}
