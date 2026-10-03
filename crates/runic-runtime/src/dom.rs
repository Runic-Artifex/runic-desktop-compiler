//! Typed DOM operations used by generated code.

use blitz_dom::{BaseDocument, LocalName, Namespace, QualName, ns};
use blitz_traits::node_id::NodeId;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Click,
    Input,
    /// Checkbox toggle (payload "true"/"false").
    Change,
    /// Key press (payload: `KeyboardEvent.key`), bubbling from the focused element.
    Keydown,
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

    pub(crate) fn get(&self, node: NodeId, event: Event) -> Option<u32> {
        self.map
            .get(&node)?
            .iter()
            .find(|(e, _)| *e == event)
            .map(|(_, h)| *h)
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
        } else {
            self.set_attr(node, "value", value);
            self.listeners.pending_caret.push(node);
        }
    }
}
