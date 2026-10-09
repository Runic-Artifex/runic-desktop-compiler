//! Live DOM adapter for the bounded, shared HTML form decisions.

use crate::dom::{Event, Listeners};
use blitz_dom::{BaseDocument, ns};
use blitz_traits::node_id::NodeId;
use runic_js::forms::Control;

/// An owned submission session. Collection finishes before any callback runs.
pub struct Submission {
    pub form: u64,
    pub event: runic_js::Event,
    pub deliveries: Vec<crate::Delivery>,
}

fn tag(doc: &BaseDocument, id: NodeId) -> Option<&str> {
    let node = doc.get_node(id)?;
    if !node.is_element() {
        return None;
    }
    let element = node.element_data()?;
    (element.name.ns == ns!(html)).then_some(&*element.name.local)
}

fn attr<'a>(doc: &'a BaseDocument, id: NodeId, name: &str) -> Option<&'a str> {
    doc.get_node(id)?.attr(name.into())
}

fn live(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id)
        .is_some_and(|node| node.is_element() && node.flags.is_in_document())
}

/// Retain only actual HTML form identities for this document's lifetime.
/// Removal does not tell us whether script still holds an element reference.
pub(crate) fn remember_forms(doc: &BaseDocument, listeners: &mut Listeners, root: NodeId) {
    listeners.known_forms.extend(
        crate::events::subtree_order(doc, root)
            .into_iter()
            .filter(|&node| tag(doc, node) == Some("form")),
    );
}

/// Snapshot the conservative detached named-property boundary before freeing
/// a subtree. Only descendant listed controls and legacy images are retained
/// as identity facts; no DOM or external explicitly owned controls are kept.
pub(crate) fn remember_removed_forms(doc: &BaseDocument, listeners: &mut Listeners, root: NodeId) {
    for form in crate::events::subtree_order(doc, root)
        .into_iter()
        .filter(|&node| tag(doc, node) == Some("form"))
    {
        listeners.known_forms.insert(form);
        if descendant_shadows_request_submit(doc, form) {
            listeners.detached_shadowed_forms.insert(form);
        }
    }
}

fn ancestors(doc: &BaseDocument, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    std::iter::successors(doc.get_node(id).and_then(|node| node.parent), |&parent| {
        doc.get_node(parent).and_then(|node| node.parent)
    })
}

/// A connected explicit owner uses the first matching element in document
/// order, including a non-form match; that case never falls back to ancestry.
pub(crate) fn owner(doc: &BaseDocument, id: NodeId) -> Option<NodeId> {
    runic_js::forms::form_owner(
        attr(doc, id, "form"),
        live(doc, id),
        |name| {
            crate::events::tree_order(doc)
                .into_iter()
                .find(|&node| live(doc, node) && attr(doc, node, "id") == Some(name))
                .map(|node| (node.as_u64(), tag(doc, node) == Some("form")))
        },
        ancestors(doc, id)
            .find(|&node| tag(doc, node) == Some("form"))
            .map(NodeId::as_u64),
    )
    .map(NodeId::from_u64)
}

/// Disabled controls inherit disabled fieldsets except through each one's
/// first legend. Controls remain in the associated-control and blocker lists.
pub(crate) fn disabled(doc: &BaseDocument, id: NodeId) -> bool {
    let control = matches!(
        tag(doc, id),
        Some("button" | "input" | "select" | "textarea")
    );
    if !control && tag(doc, id) != Some("fieldset") {
        return false;
    }
    if attr(doc, id, "disabled").is_some() {
        return true;
    }
    if !control {
        return false;
    }
    for fieldset in ancestors(doc, id) {
        if tag(doc, fieldset) != Some("fieldset") || attr(doc, fieldset, "disabled").is_none() {
            continue;
        }
        let legend = doc.get_node(fieldset).and_then(|node| {
            node.children
                .iter()
                .copied()
                .find(|&child| tag(doc, child) == Some("legend"))
        });
        if legend.is_none_or(|legend| !ancestors(doc, id).any(|node| node == legend)) {
            return true;
        }
    }
    false
}

/// Every listed form-associated control, including domains the validity
/// helper conservatively rejects unless validation is bypassed.
pub(crate) fn control(doc: &BaseDocument, id: NodeId) -> Option<Control> {
    let tag = tag(doc, id)?;
    if !matches!(
        tag,
        "button" | "fieldset" | "input" | "object" | "output" | "select" | "textarea"
    ) {
        return None;
    }
    Some(Control {
        id: id.as_u64(),
        tag: tag.into(),
        ty: attr(doc, id, "type").map(str::to_owned),
        disabled: disabled(doc, id),
        readonly: attr(doc, id, "readonly").is_some(),
        in_datalist: ancestors(doc, id).any(|node| self::tag(doc, node) == Some("datalist")),
        constraints: [
            "required",
            "pattern",
            "minlength",
            "maxlength",
            "min",
            "max",
            "step",
        ]
        .into_iter()
        .filter(|name| attr(doc, id, name).is_some())
        .map(str::to_owned)
        .collect(),
        command: attr(doc, id, "command").is_some(),
        command_for: attr(doc, id, "commandfor").is_some(),
        parent_is_select: doc
            .get_node(id)
            .and_then(|node| node.parent)
            .is_some_and(|parent| self::tag(doc, parent) == Some("select")),
        name: attr(doc, id, "name").map(str::to_owned),
        dom_id: attr(doc, id, "id").map(str::to_owned),
    })
}

pub(crate) fn controls(doc: &BaseDocument, form: NodeId) -> Vec<Control> {
    crate::events::tree_order(doc)
        .into_iter()
        .filter(|&id| live(doc, id) && owner(doc, id) == Some(form))
        .filter_map(|id| control(doc, id))
        .collect()
}

pub(crate) fn button_like(doc: &BaseDocument, id: NodeId) -> bool {
    control(doc, id).is_some_and(|control| {
        control.tag == "button"
            || (control.tag == "input"
                && matches!(
                    control.input_type(),
                    "button" | "submit" | "image" | "reset"
                ))
    })
}

fn shadows_request_submit(doc: &BaseDocument, form: NodeId) -> bool {
    crate::events::tree_order(doc).into_iter().any(|id| {
        if !live(doc, id) {
            return false;
        }
        if let Some(control) = control(doc, id) {
            return owner(doc, id) == Some(form) && control.shadows_request_submit();
        }
        // Form named-property lookup also has a legacy image fallback.
        tag(doc, id) == Some("img")
            && (owner(doc, id) == Some(form) || ancestors(doc, id).any(|node| node == form))
            && (attr(doc, id, "name") == Some("requestSubmit")
                || attr(doc, id, "id") == Some("requestSubmit"))
    })
}

fn descendant_shadows_request_submit(doc: &BaseDocument, form: NodeId) -> bool {
    crate::events::subtree_order(doc, form)
        .into_iter()
        .filter(|&id| id != form)
        .any(|id| {
            control(doc, id).is_some_and(|control| control.shadows_request_submit())
                || (tag(doc, id) == Some("img")
                    && (attr(doc, id, "name") == Some("requestSubmit")
                        || attr(doc, id, "id") == Some("requestSubmit")))
        })
}

/// The no-argument requestSubmit receiver check is separate from physical
/// submission: a named method shadow must not disable submit controls.
pub(crate) fn request(
    doc: &BaseDocument,
    listeners: &mut Listeners,
    form: NodeId,
) -> Option<Submission> {
    // Removal drops the native node, so only a recorded form identity can
    // prove that a missing receiver was a form rather than an arbitrary ID.
    if doc.get_node(form).is_none() {
        if !listeners.known_forms.contains(&form) {
            crate::unsupported("requestSubmit() on an unknown or removed non-form element");
        }
        if listeners.detached_shadowed_forms.contains(&form) {
            crate::unsupported(
                "requestSubmit() shadowed by a retained descendant named control or legacy image",
            );
        }
        crate::console::write(
            "warn",
            &[runic_js::forms::DISCONNECTED_SUBMISSION_WARNING.into()],
        );
        return None;
    }
    if tag(doc, form) != Some("form") {
        crate::unsupported("requestSubmit() on a non-form element");
        return None;
    }
    if !live(doc, form) {
        if descendant_shadows_request_submit(doc, form) {
            crate::unsupported(
                "requestSubmit() shadowed by a retained descendant named control or legacy image",
            );
        }
        crate::console::write(
            "warn",
            &[runic_js::forms::DISCONNECTED_SUBMISSION_WARNING.into()],
        );
        return None;
    }
    if shadows_request_submit(doc, form) {
        crate::unsupported("requestSubmit() shadowed by an owned named control or legacy image");
        return None;
    }
    begin(doc, listeners, form, None)
}

/// Prepare physical and programmatic submissions alike. No document or
/// listener borrow is retained by the returned session.
pub(crate) fn begin(
    doc: &BaseDocument,
    listeners: &mut Listeners,
    form: NodeId,
    submitter: Option<NodeId>,
) -> Option<Submission> {
    if !live(doc, form) || tag(doc, form) != Some("form") || !listeners.submitting.insert(form) {
        return None;
    }
    if ancestors(doc, form).any(|node| tag(doc, node) == Some("form"))
        || crate::events::subtree_order(doc, form)
            .into_iter()
            .any(|node| node != form && live(doc, node) && tag(doc, node) == Some("form"))
    {
        listeners.submitting.remove(&form);
        crate::unsupported("submission of nested live forms (parser-specific ownership)");
        return None;
    }
    let controls = controls(doc, form);
    let bypass = attr(doc, form, "novalidate").is_some()
        || submitter.is_some_and(|submitter| attr(doc, submitter, "formnovalidate").is_some());
    if !bypass && let Some(gap) = runic_js::forms::validation_gap(&controls) {
        listeners.submitting.remove(&form);
        crate::unsupported(&gap);
        return None;
    }
    let kind = Event::Submit;
    let event = runic_js::Event::new(runic_js::EventData {
        kind: kind.name().into(),
        target: runic_js::Element(form.as_u64()),
        cancelable: kind.cancelable(),
        ..Default::default()
    });
    let chain = crate::events::element_chain(doc, form);
    let mut deliveries = listeners.capture_deliveries(&chain, kind, &event);
    deliveries.extend(chain.iter().flat_map(|&node| {
        let event = &event;
        listeners
            .all(node, kind)
            .map(move |listener| crate::Delivery {
                listener,
                event: event.clone(),
                current: node.as_u64(),
            })
    }));
    Some(Submission {
        form: form.as_u64(),
        event,
        deliveries,
    })
}

pub(crate) fn complete(
    doc: &BaseDocument,
    listeners: &mut Listeners,
    form: NodeId,
    event: &runic_js::Event,
) {
    listeners.submitting.remove(&form);
    if event.default_prevented() || !live(doc, form) || tag(doc, form) != Some("form") {
        return;
    }
    crate::unsupported("uncanceled form submission (navigation, form data or dialog submission)");
}
