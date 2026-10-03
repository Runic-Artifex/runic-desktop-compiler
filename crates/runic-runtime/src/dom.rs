//! Typed DOM operations used by generated code.

use blitz_dom::{BaseDocument, LocalName, Namespace, QualName, ns};
use blitz_traits::node_id::NodeId;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Click,
    Input,
}

/// Listener registrations: element → (event, handler index).
#[derive(Default)]
pub(crate) struct Listeners {
    map: HashMap<NodeId, Vec<(Event, u32)>>,
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
        let listeners = &mut self.listeners.map;
        self.doc
            .mutate()
            .remove_and_drop_node_with(node, &mut |freed| {
                listeners.remove(&freed);
            });
    }

    pub fn listen(&mut self, node: NodeId, event: Event, handler: u32) {
        self.listeners
            .map
            .entry(node)
            .or_default()
            .push((event, handler));
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
