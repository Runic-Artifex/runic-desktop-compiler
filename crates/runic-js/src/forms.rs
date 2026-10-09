//! Shared, bounded HTML form decisions. The host and interpreter own their
//! trees and collect live, document-ordered associated controls. This module
//! never dispatches events or guesses constraint validity from a value.

/// Chromium reports this warning for a disconnected requestSubmit receiver.
pub const DISCONNECTED_SUBMISSION_WARNING: &str =
    "Form submission canceled because the form is not connected";

#[derive(Clone, Debug, Default)]
pub struct Control {
    pub id: u64,
    pub tag: String,
    pub ty: Option<String>,
    pub disabled: bool,
    pub readonly: bool,
    pub in_datalist: bool,
    /// Present constraint attributes: required, pattern, minlength,
    /// maxlength, min, max, step. Even invalid spellings are conservatively
    /// outside this first checkpoint's validation proof.
    pub constraints: Vec<String>,
    pub command: bool,
    pub command_for: bool,
    pub parent_is_select: bool,
    pub name: Option<String>,
    pub dom_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    None,
    Submit,
    Reset,
    UnsupportedCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Implicit {
    Nothing,
    Click(u64),
    Submit,
}

impl Control {
    pub fn input_type(&self) -> &str {
        const TYPES: &[&str] = &[
            "hidden",
            "text",
            "search",
            "tel",
            "url",
            "email",
            "password",
            "date",
            "month",
            "week",
            "time",
            "datetime-local",
            "number",
            "range",
            "color",
            "checkbox",
            "radio",
            "file",
            "submit",
            "image",
            "reset",
            "button",
        ];
        let ty = self.ty.as_deref().unwrap_or("text");
        TYPES
            .iter()
            .copied()
            .find(|t| ty.eq_ignore_ascii_case(t))
            .unwrap_or("text")
    }

    pub fn activation(&self) -> Activation {
        let ty = self.ty.as_deref().unwrap_or("");
        match self.tag.as_str() {
            "button" if ty.eq_ignore_ascii_case("reset") => Activation::Reset,
            "button" if ty.eq_ignore_ascii_case("button") => Activation::None,
            "button" if ty.eq_ignore_ascii_case("submit") => Activation::Submit,
            // Missing/invalid button type is Auto in current HTML. Command
            // invokers and customizable selects have a different activation.
            "button" if self.command || self.command_for || self.parent_is_select => {
                Activation::UnsupportedCommand
            }
            "button" => Activation::Submit,
            "input" => match self.input_type() {
                "submit" | "image" => Activation::Submit,
                "reset" => Activation::Reset,
                _ => Activation::None,
            },
            _ => Activation::None,
        }
    }

    /// The deliberately supported Enter trigger domain. The blocker count
    /// below is broader and includes disabled and readonly owned controls.
    pub fn enter_trigger(&self) -> bool {
        self.tag == "input" && matches!(self.input_type(), "text" | "search" | "tel" | "password")
    }

    pub fn blocks_implicit(&self) -> bool {
        self.tag == "input"
            && matches!(
                self.input_type(),
                "text"
                    | "search"
                    | "tel"
                    | "url"
                    | "email"
                    | "password"
                    | "date"
                    | "month"
                    | "week"
                    | "time"
                    | "datetime-local"
                    | "number"
            )
    }

    fn readonly_applies(&self) -> bool {
        self.tag == "textarea" || self.blocks_implicit()
    }

    pub fn shadows_request_submit(&self) -> bool {
        self.name.as_deref() == Some("requestSubmit")
            || self.dom_id.as_deref() == Some("requestSubmit")
    }
}

/// Explicit ownership never falls back when the first matching ID is absent
/// or belongs to a non-form. Adapters supply actual tree lookup and ancestry.
pub fn form_owner(
    explicit: Option<&str>,
    connected: bool,
    first_id: impl FnOnce(&str) -> Option<(u64, bool)>,
    nearest_ancestor_form: Option<u64>,
) -> Option<u64> {
    if let Some(id) = explicit.filter(|_| connected) {
        first_id(id).and_then(|(id, is_form)| is_form.then_some(id))
    } else {
        nearest_ancestor_form
    }
}

pub fn implicit_submission(controls: &[Control]) -> Implicit {
    if let Some(default) = controls
        .iter()
        .find(|c| c.activation() == Activation::Submit)
    {
        return if default.disabled {
            Implicit::Nothing
        } else {
            Implicit::Click(default.id)
        };
    }
    if controls.iter().filter(|c| c.blocks_implicit()).count() > 1 {
        Implicit::Nothing
    } else {
        Implicit::Submit
    }
}

/// A conservative validity proof for this checkpoint, evaluated only when
/// neither the form nor the actual initiating submitter bypasses validation.
/// It deliberately does not implement invalid events, validation UI, dirty
/// value history, intrinsic input constraints, or custom validity.
pub fn validation_gap(controls: &[Control]) -> Option<String> {
    // Required radio validity is group-wide, including barred siblings.
    if controls.iter().any(|c| {
        c.tag == "input"
            && c.input_type() == "radio"
            && c.constraints.iter().any(|s| s == "required")
    }) {
        return Some("form validation (a required radio group)".into());
    }
    for c in controls {
        if c.disabled || c.in_datalist || (c.readonly && c.readonly_applies()) {
            continue;
        }
        let ty = if c.tag == "input" {
            c.input_type()
        } else {
            c.tag.as_str()
        };
        if c.tag == "button" || matches!(ty, "hidden" | "reset" | "button" | "submit" | "image") {
            // Submit buttons are candidates, but cannot have custom validity
            // in the supported language; their native validity is true.
            continue;
        }
        if !c.constraints.is_empty() {
            return Some(format!(
                "form validation ({} on control {})",
                c.constraints.join(", "),
                c.id
            ));
        }
        if !matches!(
            ty,
            "text" | "search" | "tel" | "password" | "textarea" | "select" | "checkbox" | "radio"
        ) {
            return Some(format!("form validation (the {ty} input domain)"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn control(id: u64, tag: &str, ty: Option<&str>) -> Control {
        Control {
            id,
            tag: tag.into(),
            ty: ty.map(Into::into),
            ..Default::default()
        }
    }
    #[test]
    fn owner_requires_the_first_matching_element_to_be_a_form() {
        assert_eq!(
            form_owner(Some("x"), true, |_| Some((7, true)), Some(2)),
            Some(7)
        );
        assert_eq!(
            form_owner(Some("x"), true, |_| Some((7, false)), Some(2)),
            None
        );
        assert_eq!(form_owner(Some("missing"), true, |_| None, Some(2)), None);
        assert_eq!(form_owner(None, true, |_| None, Some(2)), Some(2));
    }
    #[test]
    fn implicit_default_button_does_not_skip_disabled_or_external_controls() {
        let field = control(1, "input", None);
        let mut disabled = control(2, "button", None);
        disabled.disabled = true;
        assert_eq!(
            implicit_submission(&[
                field.clone(),
                disabled,
                control(3, "button", Some("submit"))
            ]),
            Implicit::Nothing
        );
        assert_eq!(
            implicit_submission(&[control(9, "input", Some("SUBMIT")), field]),
            Implicit::Click(9)
        );
    }
    #[test]
    fn blocker_classification_is_distinct_from_supported_enter_and_validity() {
        let text = control(1, "input", Some("unknown"));
        let mut date = control(2, "input", Some("date"));
        date.disabled = true;
        date.readonly = true;
        assert!(text.enter_trigger());
        assert!(date.blocks_implicit());
        assert!(!date.enter_trigger());
        assert_eq!(implicit_submission(&[text, date]), Implicit::Nothing);
        assert_eq!(
            implicit_submission(&[control(1, "input", Some("text"))]),
            Implicit::Submit
        );
        assert!(!control(3, "textarea", None).enter_trigger());
    }
    #[test]
    fn validation_never_guesses_intrinsic_or_radio_group_validity() {
        assert_eq!(
            validation_gap(&[
                control(1, "input", Some("text")),
                control(2, "select", None)
            ]),
            None
        );
        assert!(validation_gap(&[control(1, "input", Some("email"))]).is_some());
        let mut radio = control(1, "input", Some("radio"));
        radio.disabled = true;
        radio.constraints.push("required".into());
        assert!(validation_gap(&[radio, control(2, "input", Some("radio"))]).is_some());
        let mut readonly = control(1, "input", Some("number"));
        readonly.readonly = true;
        assert_eq!(validation_gap(&[readonly]), None);
    }
    #[test]
    fn auto_button_command_behavior_is_not_silently_submitted() {
        let mut c = control(1, "button", None);
        c.command = true;
        assert_eq!(c.activation(), Activation::UnsupportedCommand);
        c.ty = Some("SUBMIT".into());
        assert_eq!(c.activation(), Activation::Submit);
        assert_eq!(
            control(2, "button", Some("reset")).activation(),
            Activation::Reset
        );
    }
}
