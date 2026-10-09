# M6: bubbling hover boundaries

Finish the existing four-event breadth sweep before consolidating the parity
work. `pointerover`, `pointerout`, `mouseover` and `mouseout` use schema 4's
existing listener and EventData representation. No new framework-specific
backend rule or JavaScript engine is introduced.

Native hit targets are normalized to their nearest live element before comparing
the old and new targets. Moving between text nodes or padding of that same
element emits no over/out boundaries. Leaving and entering elements retains
Blitz's ancestry changes and the existing pointer-before-mouse order; each target
is checked for liveness immediately before delivery.

All boundary events use the opposite element as `relatedTarget`, or null when
that endpoint is absent. Target and related target are captured for the move;
later listener mutations do not redefine their identity. Removed delivery
targets receive no subsequent events. The interpreter uses the same element
identity and data policy; its scripted hover does not perform coordinate hit
testing. Native/browser point actions and a native tree test cover text/padding.

Pointer movement and its boundary events identify no button transition with
`button = -1`; mouse events keep their mouse button data. Boundaries generated
by a pointer press/release retain that changed button instead. This follows the
[Pointer Events button policy](https://www.w3.org/TR/pointerevents3/#the-button-property);
the diagnostic case records button and buttons separately at the locked browser.

Host/rest listener declarations include the four events. Differential trace
generation maps them to hover actions and reports unmapped listener actions as
incomplete rather than certifying a mount-only trace. React's existing rejection
of same-family enter/leave mixed with over/out remains explicit because its
synthetic timing differs from browser boundary order.

Driving evidence retains the original three-framework hover case and adds
related-target and same-element point reductions. Compiler/workspace checks,
browser/native event conformance and nonempty differential traces are required.
OS pointer delivery and broader renderer parity remain separate stages. Form
submission is a subsequent checkpoint; its unwired helpers are preserved on a
separate branch rather than accepted as implemented behavior.

This checkpoint verifies mouse hover. Touch/pen contact-generated movement and
OS pointer delivery require separate device-specific evidence.
