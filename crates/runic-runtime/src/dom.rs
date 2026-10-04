//! Typed DOM operations used by generated code.

use blitz_dom::{BaseDocument, LocalName, Namespace, QualName, ns};
use blitz_traits::node_id::NodeId;
use std::collections::HashMap;

/// Event kinds (the IR's `EventKind`, docs/design/M5-PLATFORM.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Click,
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
    Wheel,
    Focus,
    Blur,
    Focusin,
    Focusout,
}

impl Event {
    pub const ALL: [Event; 22] = [
        Event::Click,
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
        Event::Wheel,
        Event::Focus,
        Event::Blur,
        Event::Focusin,
        Event::Focusout,
    ];

    /// The kind named `name` (`event.type`).
    pub fn parse(name: &str) -> Option<Event> {
        Event::ALL.into_iter().find(|e| e.name() == name)
    }

    /// `event.type`.
    pub fn name(self) -> &'static str {
        match self {
            Event::Click => "click",
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
            Event::Wheel => "wheel",
            Event::Focus => "focus",
            Event::Blur => "blur",
            Event::Focusin => "focusin",
            Event::Focusout => "focusout",
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
        )
    }

    /// The probe action that delivers the event (as `EventKind::action`).
    pub fn action(self) -> &'static str {
        match self {
            Event::Click
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
            | Event::Mouseleave => "hover",
            Event::Input => "input",
            Event::Keydown | Event::Keyup => "keydown",
            Event::Wheel => "wheel",
            Event::Focus | Event::Blur | Event::Focusin | Event::Focusout => "focus",
        }
    }
}

/// Listener registrations: element → (event, listener key of the app).
#[derive(Default)]
pub(crate) struct Listeners {
    map: HashMap<NodeId, Vec<(Event, u32)>>,
    /// Keys of listeners whose elements were removed (the app frees them).
    freed: Vec<u32>,
    /// An element that lost focus because a list move detached it.
    pub(crate) blurred: Option<NodeId>,
    /// Inputs whose value was set by script before their editor existed: the
    /// caret moves to the end once the editor is created (as `input.value = v`).
    pending_caret: Vec<NodeId>,
}

impl Listeners {
    /// Apply pending caret moves for editors created since (call after layout).
    pub(crate) fn settle(&mut self, doc: &mut BaseDocument) {
        self.pending_caret.retain(|&id| {
            if doc.get_node(id).is_none() {
                return false;
            }
            if !crate::controls::has_editor(doc, id) {
                return true;
            }
            doc.with_text_input(id, |mut editor| editor.move_to_text_end());
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

    /// Whether `node` has a listener for an event `action` delivers.
    #[cfg(feature = "probe")]
    pub(crate) fn listens(&self, node: NodeId, action: &str) -> bool {
        self.map
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
    listeners: Vec<(Event, u32, usize)>,
}

impl<L> Default for Spread<L> {
    fn default() -> Self {
        Spread {
            bag: None,
            names: Vec::new(),
            listeners: Vec::new(),
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
        Host {
            doc: Some(&mut *dom.doc as *mut BaseDocument),
            listeners: Some(&mut *dom.listeners as *mut Listeners),
        }
    }

    fn dom(&self) -> Option<Dom<'_>> {
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
        match next {
            Some(n) => {
                dom.doc.set_focus_to(n);
            }
            None => dom.doc.clear_focus(),
        }
        let mut out = vec![];
        let mut push = |target: NodeId, kind: Event, related: Option<NodeId>| {
            let chain = crate::events::element_chain(dom.doc, target);
            let path = if kind.bubbles() {
                &chain[..]
            } else {
                &chain[..1.min(chain.len())]
            };
            let event = runic_js::Event::new(runic_js::EventData {
                kind: kind.name().into(),
                target: runic_js::Element(target.as_u64()),
                related: related.map(|r| runic_js::Element(r.as_u64())),
                ..Default::default()
            });
            let deliveries = path
                .iter()
                .flat_map(|&n| {
                    let event = &event;
                    dom.listeners
                        .all(n, kind)
                        .map(move |listener| crate::Delivery {
                            listener,
                            event: event.clone(),
                            current: n.as_u64(),
                        })
                })
                .collect();
            out.push((event, kind, deliveries));
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

pub struct Dom<'a> {
    pub(crate) doc: &'a mut BaseDocument,
    pub(crate) listeners: &'a mut Listeners,
}

fn attr(name: &str) -> QualName {
    QualName::new(None, Namespace::from(""), LocalName::from(name))
}

impl Dom<'_> {
    pub fn element(&mut self, tag: &str) -> NodeId {
        self.doc
            .mutate()
            .create_element(QualName::new(None, ns!(html), LocalName::from(tag)), vec![])
    }

    pub fn text(&mut self, text: &str) -> NodeId {
        self.doc.mutate().create_text_node(text)
    }

    pub fn set_text(&mut self, node: NodeId, text: &str) {
        self.doc.mutate().set_node_text(node, text);
    }

    pub fn set_attr(&mut self, node: NodeId, name: &str, value: &str) {
        self.doc.mutate().set_attribute(node, attr(name), value);
    }

    /// Optional attributes are present iff `value` is Some.
    pub fn set_opt_attr(&mut self, node: NodeId, name: &str, value: Option<&str>) {
        let mut m = self.doc.mutate();
        match value {
            Some(v) => m.set_attribute(node, attr(name), v),
            None => m.clear_attribute(node, attr(name)),
        }
    }

    /// Boolean attributes are present (with an empty value) iff `on`.
    pub fn set_bool_attr(&mut self, node: NodeId, name: &str, on: bool) {
        let mut m = self.doc.mutate();
        if on {
            m.set_attribute(node, attr(name), "");
        } else {
            m.clear_attribute(node, attr(name));
        }
    }

    pub fn append(&mut self, parent: NodeId, child: NodeId) {
        self.doc.mutate().append_children(parent, &[child]);
    }

    /// Insert `child` into `parent` before `before`, or append.
    pub fn insert(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        let mut m = self.doc.mutate();
        match before {
            Some(anchor) => m.insert_nodes_before(anchor, &[child]),
            None => m.append_children(parent, &[child]),
        }
    }

    /// Detach and free a subtree, dropping its listener registrations.
    pub fn remove(&mut self, node: NodeId) {
        let Listeners { map, freed, .. } = &mut *self.listeners;
        self.doc
            .mutate()
            .remove_and_drop_node_with(node, &mut |gone| {
                if let Some(list) = map.remove(&gone) {
                    freed.extend(list.into_iter().map(|(_, key)| key));
                }
            });
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
        if let Some(focused) = self.doc.get_focussed_node_id() {
            let mut cur = Some(focused);
            while let Some(c) = cur {
                if nodes.contains(&c) {
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
    }

    /// Apply an element's attribute bag: attributes it no longer holds are
    /// removed and listener registrations follow its `on<event>` entries
    /// (`listen` registers a listener with the app and gives its key).
    pub fn spread<L: Clone>(
        &mut self,
        node: NodeId,
        bag: &runic_js::Attrs<L>,
        applied: &mut Spread<L>,
        listen: &mut dyn FnMut(L) -> u32,
    ) {
        use runic_js::{AttrValue, StrictEq};
        if applied.bag.as_ref().is_some_and(|b| b.strict_eq(bag)) {
            return;
        }
        let mut names = vec![];
        let mut wanted: Vec<(Event, usize, L)> = vec![];
        for (name, value) in bag.resolved() {
            let name = name.to_rust();
            if let AttrValue::Listener(id, f) = value {
                if let Some(event) = name.strip_prefix("on").and_then(Event::parse) {
                    wanted.push((event, *id, f.clone()));
                }
                continue;
            }
            match value {
                AttrValue::Text(t) => self.set_attr(node, &name, &t.to_rust()),
                AttrValue::Flag(true) => self.set_attr(node, &name, ""),
                _ => continue,
            }
            names.push(name);
        }
        for old in &applied.names {
            if !names.contains(old) {
                self.set_opt_attr(node, old, None);
            }
        }
        // Listeners: keep registrations of the same function, drop the
        // others, register the new ones.
        let mut kept = vec![];
        for (event, key, id) in std::mem::take(&mut applied.listeners) {
            if wanted.iter().any(|(e, i, _)| *e == event && *i == id) {
                kept.push((event, key, id));
            } else {
                self.unlisten(node, key);
            }
        }
        for (event, id, f) in wanted {
            if !kept.iter().any(|(e, _, i)| *e == event && *i == id) {
                let key = listen(f);
                self.listen(node, event, key);
                kept.push((event, key, id));
            }
        }
        applied.listeners = kept;
        applied.names = names;
        applied.bag = Some(bag.clone());
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
    pub fn apply_root(&mut self, root: &runic_css::Root) {
        let Some(html) = self.doc.try_root_element().map(|e| e.id) else {
            return;
        };
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
        self.listeners.freed.push(key);
    }

    pub fn listen(&mut self, node: NodeId, event: Event, handler: u32) {
        self.listeners
            .map
            .entry(node)
            .or_default()
            .push((event, handler));
    }

    /// Set the live checked state of a checkbox. Before layout has created the
    /// control, the state is given by the presence of the `checked` attribute,
    /// which Blitz uses to initialise it.
    pub fn set_checked(&mut self, node: NodeId, on: bool) {
        let live = self
            .doc
            .get_node(node)
            .and_then(|n| n.element_data())
            .and_then(|e| e.checkbox_input_checked());
        match live {
            Some(current) if current != on => {
                self.doc
                    .snapshot_node_and(node, style_dom::ElementState::CHECKED, |n| {
                        if let Some(el) = n.element_data_mut() {
                            el.set_checkbox_input_checked(on);
                        }
                        n.mark_ancestors_dirty();
                    });
            }
            Some(_) => {}
            None => self.set_bool_attr(node, "checked", on),
        }
    }

    /// Focus again an element that a list move blurred, if it is still in the
    /// document (frameworks that restore focus around their DOM updates).
    pub fn restore_focus(&mut self) {
        if let Some(node) = self.listeners.blurred.take() {
            if self
                .doc
                .get_node(node)
                .is_some_and(|n| n.flags.is_in_document())
            {
                self.doc.set_focus_to(node);
            }
        }
    }

    /// The live value of a text control, once its editor exists.
    pub fn value(&self, node: NodeId) -> Option<String> {
        crate::controls::value(self.doc, node)
    }

    /// Set the live value of a text control. Equal values are left untouched
    /// so selection and composition survive echoes. Before layout has created
    /// the editor, the value is provided through the `value` attribute, which
    /// Blitz uses to initialise it.
    pub fn set_value(&mut self, node: NodeId, value: &str) {
        if crate::controls::has_editor(self.doc, node) {
            crate::controls::live_value(self.doc, node, value);
        } else if self
            .doc
            .get_node(node)
            .and_then(|n| n.element_data())
            .is_some_and(|e| &*e.name.local == "textarea")
        {
            // A text area's editor starts from its text content.
            let children: Vec<_> = self
                .doc
                .get_node(node)
                .map(|n| n.children.to_vec())
                .unwrap_or_default();
            for c in children {
                self.doc.mutate().remove_and_drop_node(c);
            }
            let text = self.text(value);
            self.append(node, text);
            self.listeners.pending_caret.push(node);
        } else {
            self.set_attr(node, "value", value);
            self.listeners.pending_caret.push(node);
        }
    }
}
