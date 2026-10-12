//! Typed DOM operations used by generated code.

use blitz_dom::{BaseDocument, LocalName, Namespace, QualName, ns};
use blitz_traits::node_id::NodeId;
use std::collections::HashMap;

/// Event kinds (the IR's `EventKind`, docs/design/M5-PLATFORM.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Click,
    /// Cancelable form submission following activation or requestSubmit.
    Submit,
    Input,
    /// Checkbox toggle.
    Change,
    /// Key press, bubbling from the focused element.
    Keydown,
    Keyup,
    Dblclick,
    Contextmenu,
    Pointerdown,
    Pointerup,
    Pointermove,
    Pointerenter,
    Pointerleave,
    Mousedown,
    Mouseup,
    Mousemove,
    Mouseenter,
    Mouseleave,
    /// Bubbling boundary events (M6).
    Pointerover,
    Pointerout,
    Mouseover,
    Mouseout,
    Wheel,
    Focus,
    Blur,
    Focusin,
    Focusout,
    /// A scroller moved (not bubbling at elements; at the document it
    /// bubbles to the window). Dispatched in the rendering step.
    Scroll,
    /// The viewport changed size (window listeners; rendering step).
    Resize,
    /// Session history events, fired at the window only.
    Popstate,
    Hashchange,
    /// An `<img>`'s image loaded or failed (M6 images; not bubbling, a task
    /// after the one that determined the outcome).
    Load,
    Error,
}

impl Event {
    pub const ALL: [Event; 33] = [
        Event::Click,
        Event::Submit,
        Event::Input,
        Event::Change,
        Event::Keydown,
        Event::Keyup,
        Event::Dblclick,
        Event::Contextmenu,
        Event::Pointerdown,
        Event::Pointerup,
        Event::Pointermove,
        Event::Pointerenter,
        Event::Pointerleave,
        Event::Mousedown,
        Event::Mouseup,
        Event::Mousemove,
        Event::Mouseenter,
        Event::Mouseleave,
        Event::Pointerover,
        Event::Pointerout,
        Event::Mouseover,
        Event::Mouseout,
        Event::Wheel,
        Event::Focus,
        Event::Blur,
        Event::Focusin,
        Event::Focusout,
        Event::Scroll,
        Event::Resize,
        Event::Popstate,
        Event::Hashchange,
        Event::Load,
        Event::Error,
    ];

    /// The kind named `name` (`event.type`).
    pub fn parse(name: &str) -> Option<Event> {
        Event::ALL.into_iter().find(|e| e.name() == name)
    }

    /// The event of a listener attribute name and whether it listens in the
    /// capture phase: `on<event>` or `on<event>capture` (Svelte's
    /// `onfocuscapture`, M6 overlays).
    pub fn listener(name: &str) -> Option<(Event, bool)> {
        let rest = name.strip_prefix("on")?;
        if let Some(e) = Event::parse(rest) {
            return Some((e, false));
        }
        rest.strip_suffix("capture")
            .and_then(Event::parse)
            .map(|e| (e, true))
    }

    /// `event.type`.
    pub fn name(self) -> &'static str {
        match self {
            Event::Click => "click",
            Event::Submit => "submit",
            Event::Input => "input",
            Event::Change => "change",
            Event::Keydown => "keydown",
            Event::Keyup => "keyup",
            Event::Dblclick => "dblclick",
            Event::Contextmenu => "contextmenu",
            Event::Pointerdown => "pointerdown",
            Event::Pointerup => "pointerup",
            Event::Pointermove => "pointermove",
            Event::Pointerenter => "pointerenter",
            Event::Pointerleave => "pointerleave",
            Event::Mousedown => "mousedown",
            Event::Mouseup => "mouseup",
            Event::Mousemove => "mousemove",
            Event::Mouseenter => "mouseenter",
            Event::Mouseleave => "mouseleave",
            Event::Pointerover => "pointerover",
            Event::Pointerout => "pointerout",
            Event::Mouseover => "mouseover",
            Event::Mouseout => "mouseout",
            Event::Wheel => "wheel",
            Event::Focus => "focus",
            Event::Blur => "blur",
            Event::Focusin => "focusin",
            Event::Focusout => "focusout",
            Event::Scroll => "scroll",
            Event::Resize => "resize",
            Event::Popstate => "popstate",
            Event::Hashchange => "hashchange",
            Event::Load => "load",
            Event::Error => "error",
        }
    }

    pub fn bubbles(self) -> bool {
        !matches!(
            self,
            Event::Pointerenter
                | Event::Pointerleave
                | Event::Mouseenter
                | Event::Mouseleave
                | Event::Focus
                | Event::Blur
                | Event::Scroll
                | Event::Resize
                | Event::Popstate
                | Event::Hashchange
                | Event::Load
                | Event::Error
        )
    }

    pub fn cancelable(self) -> bool {
        !matches!(
            self,
            Event::Input
                | Event::Change
                | Event::Pointerenter
                | Event::Pointerleave
                | Event::Mouseenter
                | Event::Mouseleave
                | Event::Focus
                | Event::Blur
                | Event::Focusin
                | Event::Focusout
                | Event::Scroll
                | Event::Resize
                | Event::Popstate
                | Event::Hashchange
                | Event::Load
                | Event::Error
        )
    }

    /// The probe action that delivers the event (as `EventKind::action`).
    pub fn action(self) -> &'static str {
        match self {
            Event::Click
            | Event::Submit
            | Event::Change
            | Event::Pointerdown
            | Event::Pointerup
            | Event::Mousedown
            | Event::Mouseup => "click",
            Event::Dblclick => "dblclick",
            Event::Contextmenu => "contextmenu",
            Event::Pointermove
            | Event::Pointerenter
            | Event::Pointerleave
            | Event::Mousemove
            | Event::Mouseenter
            | Event::Mouseleave
            | Event::Pointerover
            | Event::Pointerout
            | Event::Mouseover
            | Event::Mouseout => "hover",
            Event::Input => "input",
            Event::Keydown | Event::Keyup => "keydown",
            Event::Wheel | Event::Scroll => "wheel",
            Event::Resize => "resize",
            Event::Focus | Event::Blur | Event::Focusin | Event::Focusout => "focus",
            Event::Popstate | Event::Hashchange => "back",
            // No input delivers them: the image's request completes.
            Event::Load | Event::Error => "load",
        }
    }
}

/// Listener registrations: element → (event, listener key of the app).
#[derive(Default)]
pub(crate) struct Listeners {
    /// Submission guards survive validation and synchronous listener dispatch.
    pub(crate) submitting: std::collections::HashSet<NodeId>,
    /// Form identities survive removal for retained JS element references.
    /// Full versioned IDs prevent a reused slot from acquiring an old type.
    pub(crate) known_forms: std::collections::HashSet<NodeId>,
    /// Removed forms with descendant named shadows. This conservative
    /// snapshot retains versioned identities only and drops with the document.
    pub(crate) detached_shadowed_forms: std::collections::HashSet<NodeId>,
    /// Existing static document forms are recorded at the first Host attach.
    forms_scanned: bool,
    map: HashMap<NodeId, Vec<(Event, u32)>>,
    /// Capture listeners of elements (attribute bag entries
    /// `on<event>capture`, M6 overlays).
    capture: HashMap<NodeId, Vec<(Event, u32)>>,
    /// Listeners of events of non-native types added by script (M6
    /// overlays): the app dispatches them; registered here to be freed with
    /// their element.
    custom: HashMap<NodeId, Vec<u32>>,
    /// Keys of listeners whose elements were removed (the app frees them).
    freed: Vec<u32>,
    /// An element that lost focus because a list move detached it.
    pub(crate) blurred: Option<NodeId>,
    /// Parents whose child lists changed (MutationObserver, M6 overlays).
    pub(crate) child_mutations: Vec<NodeId>,
    /// Elements whose children script reordered (`append_child`): the
    /// framework inserting into one is reported unsupported, as the
    /// frameworks place blocks by anchors (Svelte's comments) the runtime
    /// does not have.
    reordered: std::collections::HashSet<NodeId>,
    /// Attributes script set (`set_attribute`), by element: the framework
    /// writing one is covered where it writes the value the element has
    /// (React, Vue and Svelte skip writes of a value they set before, so
    /// one that differs is reported unsupported).
    script_attrs: HashMap<NodeId, Vec<String>>,
    /// Inputs whose value was set by script before their editor existed: the
    /// caret moves to the end once the editor is created (as `input.value = v`).
    pending_caret: Vec<NodeId>,
    /// Selects and the value they are controlled to (none: uncontrolled).
    selects: HashMap<NodeId, Option<String>>,
    /// Controlled selects whose value falls back to the first enabled option
    /// (`selectValue`, React DOM's `updateOptions`).
    select_fallback: std::collections::HashSet<NodeId>,
    /// The text content (`defaultValue`) of text areas whose editor is still
    /// to be created from a value set by script: it replaces that seed once
    /// the editor exists.
    pending_default: HashMap<NodeId, String>,
    /// Scrollers whose offset changed since the last rendering step, in
    /// order (each once): their `scroll` events are pending.
    pub(crate) pending_scroll: Vec<NodeId>,
    /// Input modality for `:focus-visible`: a key was pressed since the last
    /// mousedown, and the last focus change by the user was by mouse.
    pub(crate) had_keyboard_event: bool,
    pub(crate) mouse_focus: bool,
    /// The element the app is mounted in (`div#root`, or the container of
    /// the app's HTML template).
    pub(crate) container: Option<NodeId>,
    /// The body element (where imperative mounts append, M6).
    pub(crate) body: Option<NodeId>,
    /// The sequential focus navigation starting point a focus reset
    /// (`focus.reset`: the start of the document) or `focus.start` set.
    pub(crate) set_navigation: Option<Option<NodeId>>,
}

impl Listeners {
    /// Whether the focused element matches `:focus-visible`, by Blink's rule
    /// (`MatchesFocusVisiblePseudoClass`): it takes text input, or a key was
    /// pressed since the last mousedown, or the last user focus change was
    /// not by mouse. Script focus leaves the modality as it is.
    pub(crate) fn sync_focus_visible(&self, doc: &mut BaseDocument) {
        let Some(f) = crate::events::focused_element(doc) else {
            return;
        };
        let visible =
            crate::controls::has_editor(doc, f) || self.had_keyboard_event || !self.mouse_focus;
        doc.set_focus_visible(visible);
    }

    /// A scroller moved: its `scroll` event is pending (once).
    pub(crate) fn scrolled(&mut self, node: Option<NodeId>) {
        if let Some(n) = node.filter(|n| !self.pending_scroll.contains(n)) {
            self.pending_scroll.push(n);
        }
    }

    /// Apply pending caret moves for editors created since (call after layout).
    /// A text area's children seeded its editor with a value set by script;
    /// they are replaced by its text content (none unless one was set).
    pub(crate) fn settle(&mut self, doc: &mut BaseDocument) {
        let pending_default = &mut self.pending_default;
        self.pending_caret.retain(|&id| {
            if doc.get_node(id).is_none() {
                pending_default.remove(&id);
                return false;
            }
            if !crate::controls::has_editor(doc, id) {
                return true;
            }
            doc.with_text_input(id, |mut editor| editor.move_to_text_end());
            if let Some(text) = pending_default.remove(&id) {
                replace_text_content(doc, id, &text);
            }
            false
        });
    }

    /// The listeners of `node` for `event`, in registration order.
    pub(crate) fn all(&self, node: NodeId, event: Event) -> impl Iterator<Item = u32> + '_ {
        self.map
            .get(&node)
            .into_iter()
            .flatten()
            .filter(move |(e, _)| *e == event)
            .map(|(_, h)| *h)
    }

    /// The capture listeners of `node` for `event`, in registration order.
    pub(crate) fn all_capture(&self, node: NodeId, event: Event) -> impl Iterator<Item = u32> + '_ {
        self.capture
            .get(&node)
            .into_iter()
            .flatten()
            .filter(move |(e, _)| *e == event)
            .map(|(_, h)| *h)
    }

    /// The capture-phase deliveries of an event along `chain` (the target
    /// first, then its ancestors): from the root down to the target.
    pub(crate) fn capture_deliveries(
        &self,
        chain: &[NodeId],
        event: Event,
        e: &runic_js::Event,
    ) -> Vec<crate::Delivery> {
        chain
            .iter()
            .rev()
            .flat_map(|&n| {
                self.all_capture(n, event)
                    .map(move |listener| crate::Delivery {
                        listener,
                        event: e.clone(),
                        current: n.as_u64(),
                    })
            })
            .collect()
    }

    /// Whether `node` has a listener for an event `action` delivers.
    #[cfg(feature = "probe")]
    pub(crate) fn listens(&self, node: NodeId, action: &str) -> bool {
        self.map
            .get(&node)
            .is_some_and(|l| l.iter().any(|(e, _)| e.action() == action))
    }

    /// Whether `node` has a capture listener for an event `action` delivers.
    #[cfg(feature = "probe")]
    pub(crate) fn captures(&self, node: NodeId, action: &str) -> bool {
        self.capture
            .get(&node)
            .is_some_and(|l| l.iter().any(|(e, _)| e.action() == action))
    }
}

/// Class toggle state of an element: the class value and toggles last applied.
#[derive(Default)]
pub struct ClassState {
    value: Option<runic_js::JsString>,
    toggles: Vec<bool>,
}

/// What an element's attribute bag applied: the bag, the attributes it
/// set and its listener registrations `(event, key, identity)`.
pub struct Spread<L> {
    bag: Option<runic_js::Attrs<L>>,
    names: Vec<String>,
    listeners: Vec<(Event, bool, u32, usize)>,
    /// The inline style a `style` entry manages, and whether one does.
    style: runic_css::StyleState,
    styled: bool,
    /// The `checked` a Svelte spread last assigned to an input's property.
    checked: Option<bool>,
    /// The `defaultValue` a Svelte spread last assigned to a text control.
    default_value: Option<String>,
}

impl<L> Default for Spread<L> {
    fn default() -> Self {
        Spread {
            bag: None,
            names: Vec::new(),
            listeners: Vec::new(),
            style: Default::default(),
            styled: false,
            checked: None,
            default_value: None,
        }
    }
}

/// The document while app code runs (`cx.dom`), for script operations
/// that act at once (focus, layout reads). Attached by the generated app
/// whenever it runs app code; empty otherwise.
#[derive(Default)]
pub struct Host {
    doc: Option<*mut BaseDocument>,
    listeners: Option<*mut Listeners>,
}

impl Host {
    pub fn attach(dom: &mut Dom) -> Host {
        if !dom.listeners.forms_scanned {
            let root = dom.doc.root_node().id;
            crate::forms::remember_forms(dom.doc, dom.listeners, root);
            dom.listeners.forms_scanned = true;
        }
        Host {
            doc: Some(&mut *dom.doc as *mut BaseDocument),
            listeners: Some(&mut *dom.listeners as *mut Listeners),
        }
    }

    pub(crate) fn dom(&self) -> Option<Dom<'_>> {
        // SAFETY: attached only while the generated app runs app code inside
        // a runtime call that holds the document; that call does not use the
        // document while app code runs.
        unsafe {
            Some(Dom {
                doc: &mut *self.doc?,
                listeners: &mut *self.listeners?,
            })
        }
    }

    /// `getBoundingClientRect()` of `node`: x, y, width, height, top, right,
    /// bottom, left.
    pub fn rect(&self, node: u64) -> [f64; 8] {
        self.dom().map_or([0.0; 8], |dom| {
            crate::layout::rect(dom.doc, NodeId::from_u64(node))
        })
    }

    /// `document.elementFromPoint(x, y)` (`layout::element_from_point`).
    pub fn element_from_point(&self, x: f64, y: f64) -> Option<u64> {
        self.dom()
            .and_then(|dom| crate::layout::element_from_point(dom.doc, x, y))
    }

    /// `getClientRects()` of `node`: its border box (as `rect`), or none
    /// where it has no box. The line boxes of an inline element are not
    /// covered (reported unsupported; its bounding box stands for them).
    pub fn client_rects(&self, node: u64) -> Vec<[f64; 8]> {
        self.dom().map_or(vec![], |dom| {
            crate::layout::client_rects(dom.doc, NodeId::from_u64(node))
        })
    }

    /// A listener added by script (`addEventListener`): `key` receives
    /// `event` at `node`, as a template listener does.
    pub fn listen_element(&self, node: u64, event: Event, key: u32) {
        if let Some(mut dom) = self.dom() {
            dom.listen(NodeId::from_u64(node), event, key);
        }
    }

    /// A listener of a custom event type added by script (M6 overlays): its
    /// key is released with the element.
    pub fn listen_custom(&self, node: u64, key: u32) {
        if let Some(mut dom) = self.dom() {
            dom.listen_custom(NodeId::from_u64(node), key);
        }
    }

    /// Remove a custom event listener; its key is released (unless its
    /// element was removed, which released it).
    pub fn unlisten_custom(&self, node: u64, key: u32) {
        if let Some(mut dom) = self.dom() {
            let node = NodeId::from_u64(node);
            if dom
                .listeners
                .custom
                .get(&node)
                .is_some_and(|l| l.contains(&key))
            {
                dom.unlisten_custom(node, key);
            }
        }
    }

    /// Remove a listener added by script (`removeEventListener`); its key is
    /// released. A listener of a removed element was released with it.
    pub fn unlisten_element(&self, node: u64, key: u32) {
        if let Some(mut dom) = self.dom() {
            let node = NodeId::from_u64(node);
            if dom
                .listeners
                .map
                .get(&node)
                .is_some_and(|l| l.iter().any(|(_, k)| *k == key))
            {
                dom.unlisten(node, key);
            }
        }
    }

    /// A metric of the document element (`document.documentElement.clientWidth`).
    pub fn root_metric(&self, name: &str) -> f64 {
        self.dom().map_or(0.0, |dom| {
            let Some(root) = dom.doc.try_root_element().map(|r| r.id) else {
                return 0.0;
            };
            crate::layout::metric(dom.doc, root, name)
        })
    }

    /// `element.isConnected`: whether `node` is in the document.
    pub fn is_connected(&self, node: u64) -> bool {
        self.dom().is_some_and(|dom| {
            dom.doc
                .get_node(NodeId::from_u64(node))
                .is_some_and(|n| n.flags.is_in_document())
        })
    }

    /// `element.querySelectorAll(selector)`: the matching descendants of
    /// `node`, in tree order (a selector outside runic_js's subset is
    /// reported unsupported, and matches nothing).
    pub fn query_selector_all(&self, node: u64, selector: &str) -> Vec<u64> {
        let selector = match runic_js::parse_selector(selector) {
            Ok(s) => s,
            Err(e) => {
                crate::unsupported(&format!("querySelector: {e}"));
                return vec![];
            }
        };
        let Some(dom) = self.dom() else {
            return vec![];
        };
        struct View<'a>(&'a blitz_dom::Node);
        impl runic_js::SelElement for View<'_> {
            fn tag(&self) -> &str {
                self.0.element_data().map_or("", |e| &e.name.local)
            }
            fn attr(&self, name: &str) -> Option<&str> {
                self.0.attr(name.into())
            }
        }
        let doc = &*dom.doc;
        let Some(scope) = doc.get_node(NodeId::from_u64(node)) else {
            return vec![];
        };
        // The scope's element ancestors, from the root.
        let mut path: Vec<View> = vec![];
        let mut at = Some(scope);
        while let Some(n) = at {
            if n.element_data().is_some() {
                path.push(View(n));
            }
            at = n.parent.and_then(|p| doc.get_node(p));
        }
        path.reverse();
        fn walk<'a>(
            doc: &'a blitz_dom::BaseDocument,
            n: &'a blitz_dom::Node,
            path: &mut Vec<View<'a>>,
            selector: &runic_js::Selector,
            out: &mut Vec<u64>,
        ) {
            for &c in &n.children {
                let Some(child) = doc.get_node(c) else {
                    continue;
                };
                if child.element_data().is_none() {
                    continue;
                }
                path.push(View(child));
                if selector.matches(path) {
                    out.push(NodeId::from(child.id).as_u64());
                }
                walk(doc, child, path, selector, out);
                path.pop();
            }
        }
        let mut out = vec![];
        walk(doc, scope, &mut path, &selector, &mut out);
        out
    }

    /// `getComputedStyle(element).getPropertyValue(name)`: the computed
    /// value as Stylo serialises it (the frontend admits properties whose
    /// resolved value is the computed one); empty for an unknown name.
    pub fn computed_style(&self, node: u64, name: &str) -> String {
        use style::properties::{PropertyDeclarationId, PropertyId};
        let Some(dom) = self.dom() else {
            return String::new();
        };
        crate::layout::resolve(dom.doc);
        // Stylo supports scrollbar-gutter for Gecko only: stylesheets cannot
        // set it (the compiler rejects declarations Stylo drops), so it is
        // its initial value.
        if name == "scrollbar-gutter" {
            return "auto".into();
        }
        let Ok(id) = PropertyId::parse_enabled_for_all_content(name) else {
            return String::new();
        };
        let Some(longhand) = id.longhand_id() else {
            return String::new();
        };
        dom.doc
            .get_node(NodeId::from_u64(node))
            .and_then(|n| n.primary_styles())
            .map(|s| s.computed_value_to_string(PropertyDeclarationId::Longhand(longhand)))
            .map(|v| {
                // The resolved value of a percentage padding or margin is the
                // used length, which this does not compute.
                if (name.starts_with("padding-") || name.starts_with("margin-")) && v.ends_with('%')
                {
                    crate::unsupported(&format!("getComputedStyle {name} of a percentage ({v})"));
                }
                v
            })
            .unwrap_or_default()
    }

    /// `element.matches(":focus-visible")`: the focused element, its focus
    /// visible by Blink's rule (`Listeners::sync_focus_visible`).
    pub fn matches_focus_visible(&self, node: u64) -> bool {
        self.dom().is_some_and(|dom| {
            let id = NodeId::from_u64(node);
            crate::events::focused_element(dom.doc) == Some(id)
                && (crate::controls::has_editor(dom.doc, id)
                    || dom.listeners.had_keyboard_event
                    || !dom.listeners.mouse_focus)
        })
    }

    /// `element instanceof HTMLElement`: an element outside the SVG namespace.
    pub fn is_html(&self, node: u64) -> bool {
        self.dom().is_none_or(|dom| {
            dom.doc
                .get_node(NodeId::from_u64(node))
                .and_then(|n| n.element_data())
                .is_none_or(|e| &*e.name.ns != "http://www.w3.org/2000/svg")
        })
    }

    /// `element.closest(selector)`: the nearest inclusive ancestor element
    /// matching (a selector outside runic_js's subset is reported
    /// unsupported, and matches nothing).
    pub fn closest(&self, node: u64, selector: &str) -> Option<u64> {
        let selector = match runic_js::parse_selector(selector) {
            Ok(s) => s,
            Err(e) => {
                crate::unsupported(&format!("closest: {e}"));
                return None;
            }
        };
        let dom = self.dom()?;
        struct View<'a>(&'a blitz_dom::Node);
        impl runic_js::SelElement for View<'_> {
            fn tag(&self) -> &str {
                self.0.element_data().map_or("", |e| &e.name.local)
            }
            fn attr(&self, name: &str) -> Option<&str> {
                self.0.attr(name.into())
            }
        }
        let doc = &*dom.doc;
        // The element ancestors, from the root.
        let mut path: Vec<View> = vec![];
        let mut at = doc.get_node(NodeId::from_u64(node));
        while let Some(n) = at {
            if n.element_data().is_some() {
                path.push(View(n));
            }
            at = n.parent.and_then(|p| doc.get_node(p));
        }
        path.reverse();
        (0..path.len())
            .rev()
            .find(|&end| selector.matches(&path[..=end]))
            .map(|end| NodeId::from(path[end].0.id).as_u64())
    }

    /// `element.hasAttribute(name)`.
    pub fn has_attribute(&self, node: u64, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        self.dom().is_some_and(|dom| {
            dom.doc
                .get_node(NodeId::from_u64(node))
                .and_then(|n| n.element_data())
                .is_some_and(|e| e.attrs().iter().any(|a| *a.name.local == *name))
        })
    }

    /// `element.getAttribute(name)`.
    pub fn get_attribute(&self, node: u64, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        let dom = self.dom()?;
        dom.doc
            .get_node(NodeId::from_u64(node))
            .and_then(|n| n.element_data())
            .and_then(|e| {
                e.attrs()
                    .iter()
                    .find(|a| *a.name.local == *name)
                    .map(|a| a.value.to_string())
            })
    }

    /// `element.localName`.
    /// `element.click()` (`click_event`): the events to run nested.
    pub fn click(&self, node: u64) -> Vec<(runic_js::Event, Event, Vec<crate::Delivery>)> {
        self.dom()
            .map(|dom| click_event(&dom, NodeId::from_u64(node)))
            .unwrap_or_default()
    }

    /// Prepare requestSubmit synchronously, releasing all mutable DOM and
    /// listener borrows before the caller dispatches the owned deliveries.
    pub fn request_submit(&self, node: u64) -> Option<crate::Submission> {
        let submission = {
            let dom = self.dom()?;
            crate::forms::request(dom.doc, dom.listeners, NodeId::from_u64(node))
        };
        submission
    }

    /// Complete a requestSubmit session after all nested callbacks, including
    /// callback errors. Cancellation and removal suppress the default action.
    pub fn complete_submission(&self, form: u64, event: &runic_js::Event) {
        if let Some(dom) = self.dom() {
            crate::forms::complete(dom.doc, dom.listeners, NodeId::from_u64(form), event);
        }
    }

    /// Freeze the element path for a synchronous nested event. The target is
    /// first; callbacks may subsequently change the tree without changing it.
    /// Window/document events have no element path.
    pub fn nested_event_path(&self, target: u64) -> Vec<u64> {
        if target == runic_js::Element::WINDOW.0 || target == runic_js::Element::DOCUMENT.0 {
            return Vec::new();
        }
        self.dom().map_or_else(Vec::new, |dom| {
            crate::events::element_chain(dom.doc, NodeId::from_u64(target))
                .into_iter()
                .map(NodeId::as_u64)
                .collect()
        })
    }

    /// Copy the registrations when a nested event reaches one target and
    /// phase. The DOM borrow ends before any callback; later phases can see
    /// registrations made by earlier callbacks.
    pub fn nested_event_listeners(&self, current: u64, kind: Event, capture: bool) -> Vec<u32> {
        self.dom().map_or_else(Vec::new, |dom| {
            let current = NodeId::from_u64(current);
            if capture {
                dom.listeners.all_capture(current, kind).collect()
            } else {
                dom.listeners.all(current, kind).collect()
            }
        })
    }

    /// `element.select()`: selects all text of a text control.
    pub fn select_text(&self, node: u64) {
        if let Some(dom) = self.dom() {
            let id = NodeId::from_u64(node);
            if crate::controls::has_editor(dom.doc, id) {
                dom.doc
                    .with_text_input(id, |mut editor| editor.select_all());
            }
        }
    }

    /// `element.textContent`: the text of its descendant text nodes.
    pub fn text_content(&self, node: u64) -> String {
        self.dom()
            .and_then(|dom| {
                dom.doc
                    .get_node(NodeId::from_u64(node))
                    .map(|n| n.text_content())
            })
            .unwrap_or_default()
    }

    pub fn local_name(&self, node: u64) -> String {
        self.dom()
            .and_then(|dom| {
                dom.doc
                    .get_node(NodeId::from_u64(node))
                    .and_then(|n| n.element_data())
                    .map(|e| e.name.local.to_string())
            })
            .unwrap_or_default()
    }

    /// The parent element inside the app's DOM: none for the app's
    /// top-level elements (whose parent is the mount container).
    /// `a.contains(b)`: `b` is `a` or one of its descendants.
    pub fn contains(&self, a: u64, b: u64) -> bool {
        let Some(dom) = self.dom() else {
            return a == b;
        };
        let a = NodeId::from_u64(a);
        let mut at = Some(NodeId::from_u64(b));
        while let Some(n) = at {
            if n == a {
                return true;
            }
            at = dom.doc.get_node(n).and_then(|x| x.parent);
        }
        false
    }

    /// The next (or previous) element sibling of `node` (M6, bits-ui's
    /// Command); one that is not the program's (the container, beside
    /// content mounted in the body) is reported unsupported.
    pub fn sibling_element(&self, node: u64, next: bool) -> Option<u64> {
        let dom = self.dom()?;
        let id = NodeId::from_u64(node);
        let parent = dom.doc.get_node(dom.doc.get_node(id)?.parent?)?;
        let at = parent.children.iter().position(|&c| c == id)?;
        let mut order: Vec<NodeId> = if next {
            parent.children[at + 1..].to_vec()
        } else {
            parent.children[..at].to_vec()
        };
        if !next {
            order.reverse();
        }
        let found = order
            .into_iter()
            .find(|&c| dom.doc.get_node(c).is_some_and(|n| n.is_element()))?;
        if Some(found) == dom.listeners.container {
            crate::unsupported("a sibling that is not the program's (the container)");
            return None;
        }
        Some(found.as_u64())
    }

    /// The first child node of `node` that is not a comment (M6, bits-ui's
    /// `getFirstNonCommentChild`), where it is an element; a text node is
    /// reported unsupported (script values are elements only), unless
    /// `text`: the program only tests the value for truth and reads its
    /// data attributes, which a text node has none of (`get_attribute`).
    pub fn first_non_comment_child(&self, node: u64, text: bool) -> Option<u64> {
        let dom = self.dom()?;
        let n = dom.doc.get_node(NodeId::from_u64(node))?;
        for &c in &n.children {
            let child = dom.doc.get_node(c)?;
            if child.is_element() || (text && child.text_data().is_some()) {
                return Some(c.as_u64());
            }
            if child.text_data().is_some() {
                crate::unsupported(
                    "the first child node is a text node (script values are elements)",
                );
                return None;
            }
        }
        None
    }

    /// `parent.appendChild(child)` (M6, bits-ui's Command sorting its
    /// items): `child`, a child of `parent`, moves to its end. Another child,
    /// or one holding focus (Chromium blurs it), is reported unsupported.
    pub fn append_child(&self, parent: u64, child: u64) {
        let Some(dom) = self.dom() else { return };
        let (parent, child) = (NodeId::from_u64(parent), NodeId::from_u64(child));
        if dom.doc.get_node(child).and_then(|n| n.parent) != Some(parent) {
            crate::unsupported(
                "appendChild of a node that is not a child of the element (reordering is covered)",
            );
            return;
        }
        if let Some(focused) = dom.doc.get_focussed_node_id() {
            let mut at = Some(focused);
            while let Some(n) = at {
                if n == child {
                    crate::unsupported("appendChild of an element holding focus");
                    return;
                }
                at = dom.doc.get_node(n).and_then(|x| x.parent);
            }
        }
        dom.listeners.child_mutations.push(parent);
        dom.listeners.reordered.insert(parent);
        // (Blitz's append detaches the child first, as the DOM moves it,
        // keeping its subtree in the document.)
        dom.doc.mutate().append_children(parent, &[child]);
    }

    /// `element.setAttribute(name, value)` from script (M6, bits-ui's
    /// Command item writing its `data-value`): recorded, so that the
    /// framework writing it again is checked (`Dom::over_script`).
    pub fn set_attribute(&self, node: u64, name: &str, value: &str) {
        let Some(dom) = self.dom() else { return };
        let node = NodeId::from_u64(node);
        let name = name.to_ascii_lowercase();
        let names = dom.listeners.script_attrs.entry(node).or_default();
        if !names.contains(&name) {
            names.push(name.clone());
        }
        dom.doc.mutate().set_attribute(node, attr(&name), value);
    }

    pub fn parent_element(&self, node: u64) -> Option<u64> {
        let dom = self.dom()?;
        let parent = dom.doc.get_node(NodeId::from_u64(node))?.parent?;
        if Some(parent) == dom.listeners.container {
            return None;
        }
        dom.doc
            .get_node(parent)
            .and_then(|n| n.element_data())
            .map(|_| parent.as_u64())
    }

    /// `document.body` (M6 overlays).
    pub fn body(&self) -> Option<u64> {
        let dom = self.dom()?;
        dom.listeners.body.map(NodeId::as_u64)
    }

    /// The document element's node (M6: `getComputedStyle(document.documentElement)`).
    pub fn html(&self) -> Option<u64> {
        let dom = self.dom()?;
        dom.doc.try_root_element().map(|e| e.id.as_u64())
    }

    /// The attached document for code that mounts and removes subtrees from
    /// app code (imperative mounts, M6). Valid only while attached, as the
    /// other script operations' access is.
    pub fn dom_mut(&self) -> Option<Dom<'static>> {
        // SAFETY: as for `dom`: attached only while the generated app runs
        // app code inside a runtime call that holds the document and does
        // not use it while app code runs.
        unsafe {
            Some(Dom {
                doc: &mut *self.doc?,
                listeners: &mut *self.listeners?,
            })
        }
    }

    /// `document.querySelector(selector)` (M6 overlays: bits-ui's portal
    /// target): the first matching element of the document in tree order,
    /// the `html` element included.
    pub fn query_selector_document(&self, selector: &str) -> Option<u64> {
        let root = self.dom()?.doc.root_node().id;
        self.query_selector_all(NodeId::from(root).as_u64(), selector)
            .first()
            .copied()
    }

    /// `document.getElementById(id)`: the first element in tree order.
    pub fn element_by_id(&self, id: &str) -> Option<u64> {
        let dom = self.dom()?;
        crate::events::tree_order(dom.doc)
            .into_iter()
            .find(|&n| dom.doc.get_node(n).and_then(|x| x.attr("id".into())) == Some(id))
            .map(NodeId::as_u64)
    }

    /// The focused element (none for the body).
    pub fn focused(&self) -> Option<u64> {
        let dom = self.dom()?;
        crate::events::focused_element(dom.doc).map(NodeId::as_u64)
    }

    /// The router's focus reset (SvelteKit's `reset_focus`: the body is
    /// focused with a temporary `tabindex` and loses focus again): the
    /// focused element, if any, is blurred, and the sequential focus
    /// navigation starting point moves to the start of the document. The
    /// body's own focus events reach no listener the IR can register.
    pub fn reset_focus(&self) -> Vec<(runic_js::Event, Event, Vec<crate::Delivery>)> {
        let Some(dom) = self.dom() else {
            return vec![];
        };
        dom.listeners.set_navigation = Some(None);
        match crate::events::focused_element(dom.doc) {
            Some(f) => {
                drop(dom);
                self.focus(f.as_u64(), false)
            }
            None => vec![],
        }
    }

    /// `focus.start`: the sequential focus navigation starting point moves to
    /// `node` (a fragment navigation to it), focus staying where it is.
    pub fn focus_start(&self, node: u64) {
        if let Some(dom) = self.dom() {
            dom.listeners.set_navigation = Some(Some(NodeId::from_u64(node)));
        }
    }

    /// `element.style.getPropertyValue(name)` (the inline style).
    pub fn style_get(&self, node: u64, name: &str) -> String {
        self.dom().map_or(String::new(), |dom| {
            let css = dom
                .doc
                .get_node(NodeId::from_u64(node))
                .and_then(|n| n.attr("style".into()))
                .unwrap_or("");
            runic_css::get_property(css, name)
        })
    }

    /// `element.style[name] = value` (the inline style, through the CSSOM):
    /// an empty value removes the property; an invalid one changes nothing.
    pub fn style_set(&self, node: u64, name: &str, value: &str) {
        let Some(mut dom) = self.dom() else { return };
        let node = NodeId::from_u64(node);
        let current = dom
            .doc
            .get_node(node)
            .and_then(|n| n.attr("style".into()))
            .map(str::to_owned);
        let next = if value.is_empty() {
            current
                .as_deref()
                .map(|css| runic_css::remove_property(css, name))
        } else {
            runic_css::set_property(current.as_deref().unwrap_or(""), name, value, false)
        };
        if let Some(css) = next {
            if current.as_deref() != Some(css.as_str()) {
                dom.set_attr(node, "style", &css);
            }
        }
    }

    /// `element.getAnimations()` (M6): after bringing styles up to date,
    /// the ids of the element's running CSS animations and transitions
    /// (crate::animations), in Chromium's order.
    pub fn get_animations(&self, node: u64) -> Vec<u64> {
        let Some(dom) = self.dom() else {
            return Vec::new();
        };
        crate::layout::resolve(dom.doc);
        crate::animations::of(dom.doc, NodeId::from_u64(node))
    }

    /// `animation.playState` after bringing styles up to date (Chromium
    /// flushes style for it); None once the app took the animation's end.
    pub fn animation_play_state(&self, id: u64) -> Option<&'static str> {
        let dom = self.dom()?;
        crate::layout::resolve(dom.doc);
        crate::animations::play_state(id)
    }

    /// `animation.pending` after bringing styles up to date: no frame has
    /// seen the animation yet.
    pub fn animation_pending(&self, id: u64) -> bool {
        let Some(dom) = self.dom() else { return false };
        crate::layout::resolve(dom.doc);
        crate::animations::pending(id)
    }

    /// The ends of animations the app holds, in order, `(id, finished)`:
    /// cancellations (at once, after the style resolution that made them),
    /// and finishes too at a frame's animation step (`frame`).
    pub fn animation_ends(&self, frame: bool) -> Vec<(u64, bool)> {
        crate::animations::take_ended(frame)
            .into_iter()
            .map(|(id, how)| (id, how == crate::animations::Ended::Finished))
            .collect()
    }

    /// An element metric (`offsetWidth`, `scrollTop`, …).
    pub fn metric(&self, node: u64, name: &str) -> f64 {
        self.dom().map_or(0.0, |dom| {
            crate::layout::metric(dom.doc, NodeId::from_u64(node), name)
        })
    }

    /// A window metric (`innerWidth`, `scrollY`, …).
    pub fn window_metric(&self, name: &str) -> f64 {
        self.dom()
            .map_or(0.0, |dom| crate::layout::window_metric(dom.doc, name))
    }

    /// `scrollTop = value` (`vertical`) or `scrollLeft = value`.
    pub fn set_scroll(&self, node: u64, vertical: bool, value: f64) {
        if let Some(dom) = self.dom() {
            let moved = crate::layout::set_scroll(dom.doc, NodeId::from_u64(node), vertical, value);
            dom.listeners.scrolled(moved);
        }
    }

    /// `scrollTo` (`by`: `scrollBy`) on `node`, or on the window.
    pub fn scroll(&self, node: Option<u64>, by: bool, left: Option<f64>, top: Option<f64>) {
        if let Some(dom) = self.dom() {
            let moved = crate::layout::scroll(dom.doc, node.map(NodeId::from_u64), by, left, top);
            dom.listeners.scrolled(moved);
        }
    }

    /// `scrollIntoView({ block, inline })`.
    pub fn scroll_into_view(&self, node: u64, block: &str, inline: &str) {
        if let Some(dom) = self.dom() {
            for moved in
                crate::layout::scroll_into_view(dom.doc, NodeId::from_u64(node), block, inline)
            {
                dom.listeners.scrolled(Some(moved));
            }
        }
    }

    /// `element.focus()` (`on`) or `element.blur()`: move focus at once
    /// (to an enabled focusable element in the document; away from the
    /// focused element) and give the focus events to run nested, in order.
    pub fn focus(
        &self,
        node: u64,
        on: bool,
    ) -> Vec<(runic_js::Event, Event, Vec<crate::Delivery>)> {
        let Some(dom) = self.dom() else {
            return vec![];
        };
        let node = NodeId::from_u64(node);
        let old = crate::events::focused_element(dom.doc);
        let next = if on {
            let focusable = dom
                .doc
                .get_node(node)
                .is_some_and(|n| n.flags.is_in_document())
                && crate::events::is_focusable_element(dom.doc, node);
            if !focusable {
                return vec![];
            }
            Some(node)
        } else if old == Some(node) {
            None
        } else {
            return vec![];
        };
        if old == next {
            return vec![];
        }
        if let Some(o) = old {
            crate::controls::reset_scroll_on_blur(dom.doc, o);
        }
        match next {
            Some(n) => {
                dom.doc.set_focus_to(n);
            }
            None => dom.doc.clear_focus(),
        }
        dom.listeners.sync_focus_visible(dom.doc);
        let mut out = vec![];
        let mut push = |target: NodeId, kind: Event, related: Option<NodeId>| {
            out.push(focus_event(&dom, target, kind, related));
        };
        if let Some(o) = old {
            push(o, Event::Blur, next);
            push(o, Event::Focusout, next);
        }
        if let Some(n) = next {
            push(n, Event::Focus, old);
            push(n, Event::Focusin, old);
        }
        out
    }
}

/// A focus event at `target` with its deliveries along the current
/// ancestor chain (bubbling kinds) or at the target: the event, its kind and
/// the listener calls, for a nested run.
/// `element.click()` (M6 overlays: bits-ui's menu items on Enter and
/// Space): a click at `target`, nested in the running script (`detail` 0,
/// cancelable, bubbling), none inside a disabled control. Elements with
/// activation behaviour on the path (controls, labels, links, `summary`)
/// are reported unsupported: the runtime runs only the listeners.
pub(crate) fn click_event(
    dom: &Dom,
    target: NodeId,
) -> Vec<(runic_js::Event, Event, Vec<crate::Delivery>)> {
    let chain = crate::events::element_chain(dom.doc, target);
    if crate::events::inside_disabled(dom.doc, &chain) {
        return vec![];
    }
    let activates = chain.iter().any(|&n| {
        let Some(node) = dom.doc.get_node(n) else {
            return false;
        };
        node.element_data().is_some_and(|e| {
            let tag = &*e.name.local;
            matches!(
                tag,
                "input" | "button" | "select" | "textarea" | "option" | "label" | "summary"
            ) || (matches!(tag, "a" | "area") && node.attr("href".into()).is_some())
        })
    });
    if activates {
        crate::unsupported(
            "click() of an element with activation behaviour (a control, a label, a link or a summary)",
        );
    }
    let kind = Event::Click;
    let event = runic_js::Event::new(runic_js::EventData {
        kind: kind.name().into(),
        target: runic_js::Element(target.as_u64()),
        cancelable: kind.cancelable(),
        ..Default::default()
    });
    let mut deliveries = dom.listeners.capture_deliveries(&chain, kind, &event);
    deliveries.extend(chain.iter().flat_map(|&n| {
        let event = &event;
        dom.listeners
            .all(n, kind)
            .map(move |listener| crate::Delivery {
                listener,
                event: event.clone(),
                current: n.as_u64(),
            })
    }));
    vec![(event, kind, deliveries)]
}

fn focus_event(
    dom: &Dom,
    target: NodeId,
    kind: Event,
    related: Option<NodeId>,
) -> (runic_js::Event, Event, Vec<crate::Delivery>) {
    let chain = crate::events::element_chain(dom.doc, target);
    let path = if kind.bubbles() {
        &chain[..]
    } else {
        &chain[..1.min(chain.len())]
    };
    let value =
        crate::controls::value(dom.doc, target).or_else(|| crate::select::value(dom.doc, target));
    let event = runic_js::Event::new(runic_js::EventData {
        kind: kind.name().into(),
        target: runic_js::Element(target.as_u64()),
        related: related.map(|r| runic_js::Element(r.as_u64())),
        value: value.map(|v| v.as_str().into()).unwrap_or_default(),
        ..Default::default()
    });
    // The elements' capture listeners first, from the root to the target.
    let mut deliveries = dom.listeners.capture_deliveries(&chain, kind, &event);
    deliveries.extend(path.iter().flat_map(|&n| {
        let event = &event;
        dom.listeners
            .all(n, kind)
            .map(move |listener| crate::Delivery {
                listener,
                event: event.clone(),
                current: n.as_u64(),
            })
    }));
    (event, kind, deliveries)
}

pub struct Dom<'a> {
    pub(crate) doc: &'a mut BaseDocument,
    pub(crate) listeners: &'a mut Listeners,
}

impl Dom<'_> {
    /// What a ResizeObserver reports for element `node` (M6,
    /// `layout::observed_sizes`): content x, y, width, height; border box
    /// width, height; device-pixel content box width, height.
    pub fn observed_sizes(&self, node: u64) -> [f64; 8] {
        crate::layout::observed_sizes(self.doc, NodeId::from_u64(node))
    }

    /// IntersectionObserver geometry of element `node` (M6 overlays,
    /// `layout::intersection`) against the viewport grown by `margins`.
    pub fn intersection(
        &mut self,
        node: u64,
        margins: &[runic_js::intersection::Margin; 4],
    ) -> crate::layout::Intersection {
        crate::layout::intersection(self.doc, NodeId::from_u64(node), margins)
    }

    /// The depth of element `node` in the document.
    pub fn depth(&self, node: u64) -> usize {
        crate::layout::depth(self.doc, NodeId::from_u64(node))
    }

    /// Resolve styles and layout (between ResizeObserver deliveries).
    pub fn resolve_layout(&mut self) {
        crate::layout::resolve(self.doc);
        self.listeners.settle(self.doc);
    }
}

/// `node.textContent = text`: the children are replaced by one text node,
/// or none for the empty string.
fn replace_text_content(doc: &mut BaseDocument, node: NodeId, text: &str) {
    let children: Vec<_> = doc
        .get_node(node)
        .map(|n| n.children.to_vec())
        .unwrap_or_default();
    let mut m = doc.mutate();
    for c in children {
        m.remove_and_drop_node(c);
    }
    if !text.is_empty() {
        let t = m.create_text_node(text);
        m.append_children(node, &[t]);
    }
}

/// The SVG elements of the IR (`runic_ir::validate::SVG_TAGS`).
fn is_svg(tag: &str) -> bool {
    matches!(
        tag,
        "svg" | "g" | "path" | "circle" | "ellipse" | "line" | "polyline" | "polygon" | "rect"
    )
}

fn attr(name: &str) -> QualName {
    QualName::new(None, Namespace::from(""), LocalName::from(name))
}

/// A static node of an HTML fragment parsed at build time (`{@html}`, M6).
pub enum FragmentNode {
    Element(
        &'static str,
        &'static [(&'static str, &'static str)],
        &'static [FragmentNode],
    ),
    Text(&'static str),
}

/// An HTML string and its nodes, parsed at build time (`{@html}`, M6).
pub struct HtmlFragment {
    pub html: &'static str,
    pub nodes: &'static [FragmentNode],
}

impl Dom<'_> {
    /// The detached top-level nodes of the fragment among `candidates` whose
    /// string is `html` (`{@html}`): HTML is never parsed natively, so
    /// another string is unsupported. The empty string is no nodes.
    pub fn html(
        &mut self,
        html: &str,
        candidates: &[usize],
        table: &[HtmlFragment],
    ) -> Result<Vec<NodeId>, runic_js::Throw> {
        if html.is_empty() {
            return Ok(vec![]);
        }
        let Some(&f) = candidates.iter().find(|&&f| table[f].html == html) else {
            let what = "{@html} of a string that was not parsed at build time";
            crate::unsupported(what);
            return Err(runic_js::Throw::new("RunicUnsupportedError", what));
        };
        Ok(table[f]
            .nodes
            .iter()
            .map(|n| self.fragment_node(n))
            .collect())
    }

    fn fragment_node(&mut self, node: &FragmentNode) -> NodeId {
        match node {
            FragmentNode::Text(text) => self.text(text),
            FragmentNode::Element(tag, attrs, children) => {
                let id = self.element(tag);
                for (name, value) in attrs.iter() {
                    self.set_attr(id, name, value);
                }
                for c in children.iter() {
                    let child = self.fragment_node(c);
                    self.append(id, child);
                }
                id
            }
        }
    }

    pub fn element(&mut self, tag: &str) -> NodeId {
        // SVG elements are created in the SVG namespace, as the frameworks
        // create them (the IR validator keeps them inside an `<svg>`).
        let ns = if is_svg(tag) { ns!(svg) } else { ns!(html) };
        let id = self
            .doc
            .mutate()
            .create_element(QualName::new(None, ns, LocalName::from(tag)), vec![]);
        if tag == "select" {
            self.listeners.selects.insert(id, None);
        }
        if tag == "form" {
            self.listeners.known_forms.insert(id);
        }
        id
    }

    /// The user picks an option: it is shown, and stays shown (a controlled
    /// select keeps it until its value is applied again).
    pub(crate) fn choose_option(&mut self, select: NodeId, value: &str) {
        if let Some(desired) = self.listeners.selects.get_mut(&select) {
            if desired.is_some() {
                *desired = Some(value.to_owned());
            }
        }
        crate::select::set_value(self, select, value);
    }

    /// Show each select's option after the DOM changed (call after updates).
    pub fn settle_selects(&mut self) {
        let selects: Vec<(NodeId, Option<String>)> = self
            .listeners
            .selects
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        for (id, desired) in selects {
            if self.doc.get_node(id).is_none() {
                self.listeners.selects.remove(&id);
                self.listeners.select_fallback.remove(&id);
                continue;
            }
            let first = self.listeners.select_fallback.contains(&id);
            crate::select::settle(self, id, desired.as_deref(), first);
        }
    }

    pub fn text(&mut self, text: &str) -> NodeId {
        self.doc.mutate().create_text_node(text)
    }

    pub fn set_text(&mut self, node: NodeId, text: &str) {
        self.doc.mutate().set_node_text(node, text);
    }

    pub fn set_attr(&mut self, node: NodeId, name: &str, value: &str) {
        self.over_script(node, name, Some(value));
        self.doc.mutate().set_attribute(node, attr(name), value);
    }

    /// The framework writing attribute `name` (`None`: removing it): where
    /// script set it, covered when the element has that value already.
    fn over_script(&self, node: NodeId, name: &str, next: Option<&str>) {
        if self.script_attr_conflict(node, name, next) {
            crate::unsupported(&format!(
                "the framework writing attribute {name}, which script set to another value (the frameworks skip writes of values they set before)"
            ));
        }
    }

    /// Whether the framework writing attribute `name` of `node` (`None`:
    /// removing it) would change a value script set (`over_script`).
    pub(crate) fn script_attr_conflict(
        &self,
        node: NodeId,
        name: &str,
        next: Option<&str>,
    ) -> bool {
        let Some(names) = self.listeners.script_attrs.get(&node) else {
            return false;
        };
        if !names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            return false;
        }
        let current = self
            .doc
            .get_node(node)
            .and_then(|n| n.attr(attr(name).local))
            .map(str::to_owned);
        current.as_deref() != next
    }

    /// Optional attributes are present iff `value` is Some.
    pub fn set_opt_attr(&mut self, node: NodeId, name: &str, value: Option<&str>) {
        self.over_script(node, name, value);
        let mut m = self.doc.mutate();
        match value {
            Some(v) => m.set_attribute(node, attr(name), v),
            None => m.clear_attribute(node, attr(name)),
        }
    }

    /// Boolean attributes are present (with an empty value) iff `on`.
    pub fn set_bool_attr(&mut self, node: NodeId, name: &str, on: bool) {
        self.over_script(node, name, on.then_some(""));
        let mut m = self.doc.mutate();
        if on {
            m.set_attribute(node, attr(name), "");
        } else {
            m.clear_attribute(node, attr(name));
        }
    }

    pub fn append(&mut self, parent: NodeId, child: NodeId) {
        self.listeners.child_mutations.push(parent);
        self.doc.mutate().append_children(parent, &[child]);
        self.radios_connected(&[child]);
    }

    /// The framework placing nodes into `parent`: unsupported where script
    /// reordered its children (`append_child`).
    fn placing_into(&self, parent: NodeId) {
        if self.listeners.reordered.contains(&parent) {
            crate::unsupported(
                "the framework inserting into an element whose children script reordered (appendChild): its blocks are placed by anchors the runtime does not keep",
            );
        }
    }

    /// Insert `child` into `parent` before `before`, or append.
    pub fn insert(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        self.placing_into(parent);
        self.listeners.child_mutations.push(parent);
        let mut m = self.doc.mutate();
        match before {
            Some(anchor) => m.insert_nodes_before(anchor, &[child]),
            None => m.append_children(parent, &[child]),
        }
        drop(m);
        self.radios_connected(&[child]);
    }

    /// Detach and free a subtree, dropping its listener registrations.
    pub fn remove(&mut self, node: NodeId) {
        // Preserve even never-submitted forms before their native nodes are
        // freed, including subtrees created outside the generated Dom API.
        crate::forms::remember_removed_forms(self.doc, self.listeners, node);
        if let Some(parent) = self.doc.get_node(node).and_then(|n| n.parent) {
            self.listeners.child_mutations.push(parent);
        }
        let Listeners {
            map,
            capture,
            custom,
            freed,
            reordered,
            script_attrs,
            ..
        } = &mut *self.listeners;
        self.doc
            .mutate()
            .remove_and_drop_node_with(node, &mut |gone| {
                for list in [map.remove(&gone), capture.remove(&gone)]
                    .into_iter()
                    .flatten()
                {
                    freed.extend(list.into_iter().map(|(_, key)| key));
                }
                freed.extend(custom.remove(&gone).into_iter().flatten());
                reordered.remove(&gone);
                script_attrs.remove(&gone);
            });
    }

    /// Chromium blurs the focused element when it, or an ancestor, is removed
    /// or moved: `blur` and `focusout` (with no related target) run at once,
    /// while it is still in the document. Gives those events for a nested
    /// run before `nodes` are removed or moved, and clears focus.
    pub fn focus_loss(
        &mut self,
        nodes: &[NodeId],
    ) -> Vec<(runic_js::Event, Event, Vec<crate::Delivery>)> {
        let Some(focused) = crate::events::focused_element(self.doc) else {
            return vec![];
        };
        let mut cur = Some(focused);
        while let Some(c) = cur {
            if nodes.contains(&c) {
                crate::controls::reset_scroll_on_blur(self.doc, focused);
                self.doc.clear_focus();
                // Sequential navigation continues from where it was.
                self.listeners.blurred = Some(focused);
                return vec![
                    focus_event(self, focused, Event::Blur, None),
                    focus_event(self, focused, Event::Focusout, None),
                ];
            }
            cur = self.doc.get_node(c).and_then(|n| n.parent);
        }
        vec![]
    }

    /// Parents whose child lists changed since the last call (node ids).
    pub fn take_child_mutations(&mut self) -> Vec<u64> {
        let mut out: Vec<u64> = Vec::new();
        for n in std::mem::take(&mut self.listeners.child_mutations) {
            if !out.contains(&n.as_u64()) {
                out.push(n.as_u64());
            }
        }
        out
    }

    /// Whether node `b` is `a` or one of its descendants.
    pub fn contains(&self, a: u64, b: u64) -> bool {
        let a = NodeId::from_u64(a);
        let mut at = Some(NodeId::from_u64(b));
        while let Some(n) = at {
            if n == a {
                return true;
            }
            at = self.doc.get_node(n).and_then(|x| x.parent);
        }
        false
    }

    /// Listener keys released by removed elements since the last call.
    pub fn take_freed(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.listeners.freed)
    }

    /// Move (or insert) `nodes` into `parent` before `before`, or append them.
    /// As in Chromium, moving detaches the nodes first, so a focused element
    /// inside them loses focus.
    pub fn insert_all(&mut self, parent: NodeId, nodes: &[NodeId], before: Option<NodeId>) {
        if nodes.is_empty() {
            return;
        }
        self.placing_into(parent);
        // (Moved nodes leave their old parents' child lists too.)
        for &n in nodes {
            if let Some(old) = self.doc.get_node(n).and_then(|x| x.parent) {
                self.listeners.child_mutations.push(old);
            }
        }
        self.listeners.child_mutations.push(parent);
        if let Some(focused) = self.doc.get_focussed_node_id() {
            let mut cur = Some(focused);
            while let Some(c) = cur {
                if nodes.contains(&c) {
                    crate::controls::reset_scroll_on_blur(self.doc, focused);
                    self.doc.clear_focus();
                    self.listeners.blurred = Some(focused);
                    break;
                }
                cur = self.doc.get_node(c).and_then(|n| n.parent);
            }
        }
        let mut m = self.doc.mutate();
        match before {
            Some(anchor) => m.insert_nodes_before(anchor, nodes),
            None => m.append_children(parent, nodes),
        }
        drop(m);
        self.radios_connected(nodes);
    }

    /// Whether `node` is an element with tag `tag`.
    fn tag_is(&self, node: NodeId, tag: &str) -> bool {
        self.doc
            .get_node(node)
            .and_then(|n| n.element_data())
            .is_some_and(|e| &*e.name.local == tag)
    }

    /// Apply an element's attribute bag: attributes it no longer holds are
    /// removed and listener registrations follow its `on<event>` entries
    /// (`listen` registers a listener with the app and gives its key).
    /// With `boolean_text`, a boolean for a name without a boolean property
    /// becomes "true"/"false" (Svelte's `setAttribute`); `style` text goes
    /// through the CSSOM when it changed. Gives the bag's attachments when
    /// the bag changed (`None`: unchanged).
    pub fn spread<L: Clone>(
        &mut self,
        node: NodeId,
        bag: &runic_js::Attrs<L>,
        applied: &mut Spread<L>,
        listen: &mut dyn FnMut(L) -> u32,
        boolean_text: bool,
    ) -> Option<Vec<(runic_js::JsString, std::rc::Rc<dyn std::any::Any>)>> {
        use runic_js::{AttrValue, StrictEq};
        if applied.bag.as_ref().is_some_and(|b| b.strict_eq(bag)) {
            return None;
        }
        let mut names = vec![];
        let mut wanted: Vec<(Event, bool, usize, L)> = vec![];
        let mut attachments = vec![];
        let mut style = false;
        let mut checked = false;
        let mut default_value = false;
        for (name_js, value) in bag.resolved() {
            let name = name_js.to_rust();
            if name.starts_with(runic_js::ATTACHMENT) {
                if let AttrValue::Attach(f) = value {
                    attachments.push((name_js.clone(), std::rc::Rc::clone(f)));
                }
                continue;
            }
            if let AttrValue::Listener(id, f) = value {
                if let Some((event, capture)) = Event::listener(&name) {
                    wanted.push((event, capture, *id, f.clone()));
                }
                continue;
            }
            match (name.as_str(), value) {
                // An `<img>`'s attributes with unmodelled loading behaviour
                // (M6 images; the frontend proves a bag holds none of them
                // with a value, and rejects them as attributes).
                ("loading" | "srcset" | "sizes" | "crossorigin", v)
                    if !matches!(v, AttrValue::Absent | AttrValue::Null)
                        && self.tag_is(node, "img") =>
                {
                    crate::unsupported(&format!(
                        "the {name} attribute of <img> from a spread (its loading behaviour is not modelled)"
                    ));
                    continue;
                }
                ("style", AttrValue::Text(t)) => {
                    // `style.cssText`, when the value changed.
                    let current = self
                        .doc
                        .get_node(node)
                        .and_then(|n| n.attr("style".into()))
                        .map(str::to_owned);
                    if let Ok(next) =
                        applied
                            .style
                            .apply(current.as_deref(), Some(t.to_rust()), &[])
                    {
                        self.set_opt_attr(node, "style", next.as_deref());
                    }
                    style = true;
                    continue;
                }
                ("style", AttrValue::Style(..)) => {
                    crate::unsupported(
                        "a style object spread onto an element (set as the string [object Object])",
                    );
                    continue;
                }
                ("hidden", AttrValue::Text(t))
                    if t.to_rust().eq_ignore_ascii_case("until-found") =>
                {
                    crate::unsupported(
                        "hidden=\"until-found\" (Blitz has no find-in-page and hides the content)",
                    );
                    continue;
                }
                // Svelte's set_attributes assigns an input's `checked` to its
                // property (live state, no attribute), when it changed.
                ("checked", AttrValue::Flag(b)) if boolean_text && self.tag_is(node, "input") => {
                    if applied.checked != Some(*b) {
                        applied.checked = Some(*b);
                        self.set_checked(node, *b);
                    }
                    checked = true;
                    continue;
                }
                // Svelte's set_attributes assigns `defaultValue` to the
                // property, when it changed: an input's `value` attribute,
                // a text area's text content; on other elements an expando
                // (a select's default comes from its options).
                ("defaultValue", _) if boolean_text => {
                    let tag = self
                        .doc
                        .get_node(node)
                        .and_then(|n| n.element_data())
                        .map(|e| e.name.local.to_string())
                        .unwrap_or_default();
                    if tag != "input" && tag != "textarea" {
                        continue;
                    }
                    let AttrValue::Text(t) = value else {
                        crate::unsupported(&format!(
                            "a spread's defaultValue on <{tag}> that is not a string"
                        ));
                        continue;
                    };
                    let t = t.to_rust();
                    default_value = true;
                    if applied.default_value.as_deref() == Some(t.as_str()) {
                        continue;
                    }
                    let previous = applied.default_value.replace(t.clone());
                    if tag == "textarea" {
                        self.set_default_value(node, &t);
                    } else if previous.is_some() {
                        // The live value follows until the user edits it,
                        // which Blitz's editor does not track.
                        crate::unsupported("a spread's defaultValue changing on an <input>");
                    } else {
                        self.set_attr(node, "value", &t);
                    }
                    continue;
                }
                // `defaultChecked`: an input's `checked` attribute, which
                // its live state follows until changed; elsewhere an expando.
                ("defaultChecked", _) if boolean_text => {
                    if self.tag_is(node, "input") {
                        crate::unsupported("a spread's defaultChecked on an <input>");
                    }
                    continue;
                }
                // Svelte's set_attributes assigns a defined `value` to the
                // element's property (`element.value = v`).
                ("value", AttrValue::Text(_) | AttrValue::Flag(_)) if boolean_text => {
                    let tag = self
                        .doc
                        .get_node(node)
                        .and_then(|n| n.element_data())
                        .map(|e| e.name.local.to_string())
                        .unwrap_or_default();
                    match runic_js::spread_value(&tag) {
                        runic_js::SpreadValue::Expando => continue,
                        runic_js::SpreadValue::Reflect => {}
                        runic_js::SpreadValue::Unsupported => {
                            crate::unsupported(&format!(
                                "a spread's value on <{tag}> (Svelte assigns the value property)"
                            ));
                            continue;
                        }
                    }
                    if let AttrValue::Flag(b) = value {
                        self.set_attr(node, "value", if *b { "true" } else { "false" });
                        names.push(name);
                        continue;
                    }
                }
                _ => {}
            }
            // HTML lowercases attribute names (a camelCase prop spread onto
            // an element).
            let name = name.to_ascii_lowercase();
            match value {
                AttrValue::Text(t) => self.set_attr(node, &name, &t.to_rust()),
                AttrValue::Flag(b)
                    if boolean_text && !runic_js::BOOLEAN_PROPERTIES.contains(&name.as_str()) =>
                {
                    self.set_attr(node, &name, if *b { "true" } else { "false" })
                }
                AttrValue::Flag(true) => self.set_attr(node, &name, ""),
                // A typed value (a number): its text, as Svelte sets it.
                AttrValue::Value(v, ops) => match (ops.text)(&**v) {
                    Ok(Some(t)) => self.set_attr(node, &name, &t.to_rust()),
                    Ok(None) => continue,
                    Err(m) => {
                        crate::unsupported(&m);
                        continue;
                    }
                },
                _ => continue,
            }
            names.push(name);
        }
        for old in &applied.names {
            if !names.contains(old) {
                self.set_opt_attr(node, old, None);
            }
        }
        // A style the bag no longer sets is removed; setting it again applies it.
        if applied.styled && !style {
            self.set_opt_attr(node, "style", None);
            applied.style = Default::default();
        }
        applied.styled = style;
        // A `defaultValue` the bag no longer holds: Svelte assigns null.
        if !default_value && applied.default_value.take().is_some() {
            crate::unsupported("a spread no longer holding a defaultValue (Svelte assigns null)");
        }
        // A `checked` the bag no longer holds: Svelte assigns null (false).
        if !checked && applied.checked.take() == Some(true) {
            self.set_checked(node, false);
        }
        // Listeners: keep registrations of the same function, drop the
        // others, register the new ones.
        let mut kept = vec![];
        for (event, capture, key, id) in std::mem::take(&mut applied.listeners) {
            if wanted
                .iter()
                .any(|(e, c, i, _)| *e == event && *c == capture && *i == id)
            {
                kept.push((event, capture, key, id));
            } else {
                self.unlisten(node, key);
            }
        }
        for (event, capture, id, f) in wanted {
            if !kept
                .iter()
                .any(|(e, c, _, i)| *e == event && *c == capture && *i == id)
            {
                let key = listen(f);
                if capture {
                    self.listen_capture(node, event, key);
                } else {
                    self.listen(node, event, key);
                }
                kept.push((event, capture, key, id));
            }
        }
        applied.listeners = kept;
        applied.names = names;
        applied.bag = Some(bag.clone());
        Some(attachments)
    }

    /// Compose the class attribute from the class value and toggles: in full
    /// when the value changed, otherwise by toggling the names whose toggle
    /// changed (`classList.toggle`).
    pub fn classes(
        &mut self,
        node: NodeId,
        value: runic_js::JsString,
        toggles: &[(&str, bool)],
        state: &mut ClassState,
    ) {
        if state.value.as_ref() != Some(&value) {
            let next = runic_js::class_compose(&value, toggles).map(|c| c.to_rust());
            self.set_opt_attr(node, "class", next.as_deref());
            state.value = Some(value);
        } else {
            for (i, &(name, on)) in toggles.iter().enumerate() {
                if state.toggles.get(i) == Some(&on) {
                    continue;
                }
                let current = self
                    .doc
                    .get_node(node)
                    .and_then(|n| n.attr("class".into()))
                    .map(runic_js::JsString::from);
                if let Some(next) = runic_js::class_toggle(current.as_ref(), name, on) {
                    self.set_attr(node, "class", &next.to_rust());
                }
            }
        }
        state.toggles = toggles.iter().map(|t| t.1).collect();
    }

    /// Apply the document element's attributes to `<html>`.
    /// Apply `<body>` as scripts changed it (M6, bits-ui's scroll lock).
    pub fn apply_body(&mut self, body: &runic_css::Root) {
        let body_node = self.doc.try_root_element().and_then(|html| {
            html.children.iter().copied().find(|&c| {
                self.doc
                    .get_node(c)
                    .and_then(|n| n.element_data())
                    .is_some_and(|e| &*e.name.local == "body")
            })
        });
        if let Some(node) = body_node {
            self.apply_attrs(node, body);
        }
    }

    pub fn apply_root(&mut self, root: &runic_css::Root) {
        let Some(html) = self.doc.try_root_element().map(|e| e.id) else {
            return;
        };
        self.apply_attrs(html, root);
    }

    /// Make an element's attributes those of `state`.
    fn apply_attrs(&mut self, html: NodeId, root: &runic_css::Root) {
        let current: Vec<String> = self
            .doc
            .get_node(html)
            .and_then(|n| n.element_data())
            .map(|e| e.attrs().iter().map(|a| a.name.local.to_string()).collect())
            .unwrap_or_default();
        for name in current {
            if root.get(&name).is_none() {
                self.set_opt_attr(html, &name, None);
            }
        }
        for (name, value) in root.attrs() {
            self.set_attr(html, name, value);
        }
    }

    /// Manage the inline style from a style value and properties (Svelte's
    /// `set_style`, through the CSSOM).
    pub fn styles(
        &mut self,
        node: NodeId,
        value: Option<String>,
        properties: &[(&str, Option<String>)],
        state: &mut runic_css::StyleState,
    ) {
        let current = self
            .doc
            .get_node(node)
            .and_then(|n| n.attr("style".into()))
            .map(str::to_owned);
        if let Ok(next) = state.apply(current.as_deref(), value, properties) {
            self.set_opt_attr(node, "style", next.as_deref());
        }
    }

    /// Manage an inline style of properties only (React DOM's
    /// `setValueForStyles`, through the CSSOM).
    pub fn style_properties(
        &mut self,
        node: NodeId,
        properties: &[(&str, Option<String>)],
        state: &mut runic_css::StyleState,
    ) {
        let current = self
            .doc
            .get_node(node)
            .and_then(|n| n.attr("style".into()))
            .map(str::to_owned);
        if let Ok(next) = state.apply_properties(current.as_deref(), properties) {
            self.set_opt_attr(node, "style", next.as_deref());
        }
    }

    /// Manage the inline style from a style text in `replace` mode (Vue's
    /// `patchStyle`).
    pub fn style_text_replace(
        &mut self,
        node: NodeId,
        value: Option<String>,
        state: &mut runic_css::ReplaceState,
    ) {
        if let Ok(next) = state.apply_text(value) {
            self.set_opt_attr(node, "style", next.as_deref());
        }
    }

    /// Manage the inline style from style properties in `replace` mode.
    pub fn style_properties_replace(
        &mut self,
        node: NodeId,
        properties: &[(&str, Option<String>)],
        state: &mut runic_css::ReplaceState,
    ) {
        let current = self
            .doc
            .get_node(node)
            .and_then(|n| n.attr("style".into()))
            .map(str::to_owned);
        if let Ok(next) = state.apply_properties(current.as_deref(), properties) {
            self.set_opt_attr(node, "style", next.as_deref());
        }
    }

    /// Remove one listener registration; its key is released like those of
    /// removed elements.
    pub fn unlisten(&mut self, node: NodeId, key: u32) {
        if let Some(list) = self.listeners.map.get_mut(&node) {
            list.retain(|(_, k)| *k != key);
        }
        if let Some(list) = self.listeners.capture.get_mut(&node) {
            list.retain(|(_, k)| *k != key);
        }
        self.listeners.freed.push(key);
    }

    /// Register the key of a custom event listener of `node` (freed with it).
    pub fn listen_custom(&mut self, node: NodeId, handler: u32) {
        self.listeners.custom.entry(node).or_default().push(handler);
    }

    /// Release the key of a custom event listener of `node`.
    pub fn unlisten_custom(&mut self, node: NodeId, key: u32) {
        if let Some(list) = self.listeners.custom.get_mut(&node) {
            list.retain(|k| *k != key);
        }
        self.listeners.freed.push(key);
    }

    pub fn listen(&mut self, node: NodeId, event: Event, handler: u32) {
        self.listeners
            .map
            .entry(node)
            .or_default()
            .push((event, handler));
    }

    /// Register a capture listener of an element (M6 overlays).
    pub fn listen_capture(&mut self, node: NodeId, event: Event, handler: u32) {
        self.listeners
            .capture
            .entry(node)
            .or_default()
            .push((event, handler));
    }

    /// Set the live checked state of a checkbox. Before layout has created the
    /// control, the state is given by the presence of the `checked` attribute,
    /// which Blitz uses to initialise it.
    pub fn set_checked(&mut self, node: NodeId, on: bool) {
        // Checking a radio button unchecks the others of its group (no events).
        if on && crate::events::is_radio(self.doc, node) {
            for other in crate::events::radio_group(self.doc, node) {
                if other != node {
                    self.set_checked_one(other, false);
                }
            }
        }
        self.set_checked_one(node, on);
    }

    /// The checkedness of a checkbox or radio button (its `checked`
    /// attribute until Blitz has created the live state).
    fn is_checked(&self, node: NodeId) -> bool {
        self.doc.get_node(node).is_some_and(|n| {
            n.element_data()
                .and_then(|e| e.checkbox_input_checked())
                .unwrap_or_else(|| n.attr("checked".into()).is_some())
        })
    }

    /// Checked radio buttons that become connected uncheck the others of
    /// their group (HTML: "the element becomes connected"; Chromium connects
    /// them one by one in tree order).
    fn radios_connected(&mut self, inserted: &[NodeId]) {
        let mut radios = vec![];
        for &n in inserted {
            if !self
                .doc
                .get_node(n)
                .is_some_and(|x| x.flags.is_in_document())
            {
                continue;
            }
            for d in crate::events::subtree_order(self.doc, n) {
                if crate::events::is_radio(self.doc, d) && self.is_checked(d) {
                    radios.push(d);
                }
            }
        }
        // Each connects in turn: a checked one unchecks those before it, so
        // the last checked one in tree order stays checked.
        for radio in radios {
            self.set_checked_one(radio, true);
            for other in crate::events::radio_group(self.doc, radio) {
                if other != radio && self.is_checked(other) {
                    self.set_checked_one(other, false);
                }
            }
        }
    }

    fn set_checked_one(&mut self, node: NodeId, on: bool) {
        let live = self
            .doc
            .get_node(node)
            .and_then(|n| n.element_data())
            .and_then(|e| e.checkbox_input_checked());
        match live {
            Some(current) if current != on => crate::events::set_checked_state(self.doc, node, on),
            Some(_) => {}
            None => self.set_bool_attr(node, "checked", on),
        }
    }

    /// Focus again an element that a list move blurred, if it is still in the
    /// document (frameworks that restore focus around their DOM updates, by
    /// `focus()`): gives its `focus` and `focusin` events for a nested run.
    pub fn restore_focus(&mut self) -> Vec<(runic_js::Event, Event, Vec<crate::Delivery>)> {
        let Some(node) = self.listeners.blurred.take() else {
            return vec![];
        };
        if !self
            .doc
            .get_node(node)
            .is_some_and(|n| n.flags.is_in_document())
            || crate::events::focused_element(self.doc).is_some()
        {
            return vec![];
        }
        self.doc.set_focus_to(node);
        self.listeners.sync_focus_visible(self.doc);
        vec![
            focus_event(self, node, Event::Focus, None),
            focus_event(self, node, Event::Focusin, None),
        ]
    }

    /// The live value of a text control, once its editor exists.
    pub fn value(&self, node: NodeId) -> Option<String> {
        crate::controls::value(self.doc, node)
    }

    /// Control a select as React DOM does (`updateOptions`): the option with
    /// `value`, else the first enabled one, else the selection unchanged.
    pub fn set_select_value(&mut self, node: NodeId, value: &str) {
        self.listeners.selects.insert(node, Some(value.to_owned()));
        self.listeners.select_fallback.insert(node);
        crate::select::set_value_or_first(self, node, value);
    }

    /// Set the live value of a text control. Equal values are left untouched
    /// so selection and composition survive echoes. Before layout has created
    /// the editor, the value is provided through the `value` attribute, which
    /// Blitz uses to initialise it.
    pub fn set_value(&mut self, node: NodeId, value: &str) {
        if crate::select::is_select(self.doc, node) {
            self.listeners.selects.insert(node, Some(value.to_owned()));
            crate::select::set_value(self, node, value);
        } else if crate::controls::has_editor(self.doc, node) {
            crate::controls::live_value(self.doc, node, value);
        } else if self
            .doc
            .get_node(node)
            .and_then(|n| n.element_data())
            .is_some_and(|e| &*e.name.local == "textarea")
        {
            // A text area's editor starts from its text content. A value
            // equal to it changes nothing (the caret stays at the start, as
            // after `textarea.value = v` with the same value); another one
            // seeds the editor, and the text content replaces the seed once
            // the editor exists.
            if !self.listeners.pending_caret.contains(&node) {
                let current = self
                    .doc
                    .get_node(node)
                    .map(|n| n.text_content())
                    .unwrap_or_default();
                if current == value {
                    return;
                }
                self.listeners.pending_default.insert(node, current);
                self.listeners.pending_caret.push(node);
            }
            replace_text_content(self.doc, node, value);
        } else {
            // A value equal to the `value` attribute changes nothing (the
            // caret stays at the start, as in Chromium).
            let current = self.doc.get_node(node).and_then(|n| n.attr("value".into()));
            if current == Some(value) && !self.listeners.pending_caret.contains(&node) {
                return;
            }
            self.set_attr(node, "value", value);
            self.listeners.pending_caret.push(node);
        }
    }

    /// The value a text control shows: its editor's, or before the editor
    /// exists its `value` attribute (an input) or text content (a text area).
    pub fn control_value(&self, node: NodeId) -> String {
        if let Some(v) = self.value(node) {
            return v;
        }
        let Some(n) = self.doc.get_node(node) else {
            return String::new();
        };
        match n.element_data() {
            Some(e) if &*e.name.local == "textarea" => n.text_content(),
            _ => n.attr("value".into()).unwrap_or_default().to_owned(),
        }
    }

    /// Set a text area's text content (`defaultValue`), which is not its
    /// live value. While its editor is still to be created from a value set
    /// by script, the text content replaces that seed afterwards.
    pub fn set_default_value(&mut self, node: NodeId, text: &str) {
        if !crate::controls::has_editor(self.doc, node)
            && self.listeners.pending_caret.contains(&node)
        {
            self.listeners.pending_default.insert(node, text.to_owned());
        } else {
            replace_text_content(self.doc, node, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blitz_dom::DocumentConfig;

    /// `<div id="p"> <div id="a"></div> <div id="b"></div></div>` in a body.
    struct Fixture {
        doc: Box<BaseDocument>,
        listeners: Box<Listeners>,
        p: NodeId,
        a: NodeId,
        b: NodeId,
    }

    impl Fixture {
        fn new() -> Fixture {
            let mut doc = Box::new(BaseDocument::new(DocumentConfig::default()));
            let mut listeners = Box::<Listeners>::default();
            let mut dom = Dom {
                doc: &mut doc,
                listeners: &mut listeners,
            };
            let root = dom.doc.root_node().id;
            let (html, body) = (dom.element("html"), dom.element("body"));
            dom.append(html, body);
            dom.append(root, html);
            let [p, a, b] = ["p", "a", "b"].map(|id| {
                let el = dom.element("div");
                dom.set_attr(el, "id", id);
                el
            });
            dom.append(body, p);
            for el in [a, b] {
                let space = dom.text(" ");
                dom.append(p, space);
                dom.append(p, el);
            }
            Fixture {
                doc,
                listeners,
                p,
                a,
                b,
            }
        }

        fn dom(&mut self) -> Dom<'_> {
            Dom {
                doc: &mut self.doc,
                listeners: &mut self.listeners,
            }
        }

        fn elements(&self, parent: NodeId) -> Vec<NodeId> {
            let p = self.doc.get_node(parent).unwrap();
            p.children
                .iter()
                .copied()
                .filter(|c| self.doc.get_node(*c).is_some_and(|n| n.is_element()))
                .collect()
        }
    }

    #[test]
    fn script_attributes_are_checked_against_the_frameworks_writes() {
        let mut fx = Fixture::new();
        let (a, b) = (fx.a, fx.b);
        let host = Host::attach(&mut fx.dom());
        host.set_attribute(a.as_u64(), "Data-Value", "Calendar");
        assert_eq!(
            host.get_attribute(a.as_u64(), "data-value").as_deref(),
            Some("Calendar")
        );
        let dom = fx.dom();
        // The framework writing the value the element has changes nothing.
        assert!(!dom.script_attr_conflict(a, "data-value", Some("Calendar")));
        assert!(dom.script_attr_conflict(a, "data-value", Some("Settings")));
        assert!(dom.script_attr_conflict(a, "data-value", None));
        // Attributes script did not set, and other elements, are the framework's.
        assert!(!dom.script_attr_conflict(a, "id", Some("x")));
        assert!(!dom.script_attr_conflict(b, "data-value", Some("x")));
    }

    #[test]
    fn append_child_moves_a_child_to_the_end() {
        let mut fx = Fixture::new();
        let (p, a, b) = (fx.p, fx.a, fx.b);
        let host = Host::attach(&mut fx.dom());
        host.append_child(p.as_u64(), a.as_u64());
        assert_eq!(fx.elements(p), [b, a]);
        assert!(fx.doc.get_node(a).unwrap().flags.is_in_document());
        // Another element's child is not moved (reported unsupported).
        let host = Host::attach(&mut fx.dom());
        host.append_child(a.as_u64(), b.as_u64());
        assert_eq!(fx.elements(p), [b, a]);
    }

    #[test]
    fn the_first_child_that_is_not_a_comment_and_element_siblings() {
        let mut fx = Fixture::new();
        let (p, a, b) = (fx.p, fx.a, fx.b);
        let host = Host::attach(&mut fx.dom());
        // The first child is whitespace: a text node only where the program
        // reads nothing but data attributes and truth.
        assert_eq!(host.first_non_comment_child(p.as_u64(), false), None);
        let text = host.first_non_comment_child(p.as_u64(), true).unwrap();
        assert_ne!(text, a.as_u64());
        assert_eq!(host.get_attribute(text, "data-value"), None);
        assert_eq!(host.first_non_comment_child(a.as_u64(), true), None);
        assert_eq!(host.sibling_element(a.as_u64(), true), Some(b.as_u64()));
        assert_eq!(host.sibling_element(b.as_u64(), false), Some(a.as_u64()));
        assert_eq!(host.sibling_element(b.as_u64(), true), None);
    }
}
