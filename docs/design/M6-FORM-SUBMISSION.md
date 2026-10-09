# Bounded form submission

Owner decision, 2026-10-09. Implementation and acceptance are pending.

The first checkpoint implements canceled bubbling/cancelable `submit` events
through physical submit-control activation, Enter in supported single-line
text/search/tel/password inputs (including missing/invalid type), and the
existing no-argument `requestSubmit()` builtin. React and Vue gain the existing
`form` element. This extends existing event registries within schema 4; it does
not add a new IR node or framework-specific backend branch.

`runic-js::forms` owns pure HTML decisions: control classification, explicit
versus ancestor form ownership, default-button/blocker decisions, and a
conservative validity proof. Native DOM and interpreter VNode adapters own live
lookup, effective disabled state and document-order control collection. The
first matching ID must actually be a form; invalid explicit ownership never
falls back. External owned controls participate in document order. The first
submit button remains the default even when disabled. Disabled and readonly
inputs still count in the twelve-state implicit blocker set. Supported Enter
triggers are deliberately narrower than that set.

The native adapter captures active composition before keydown callbacks and
keeps composing Enter on the existing editor path, without implicit submission.
This follows the composition exclusion in the [UI Events key algorithm](https://w3c.github.io/uievents/event-algo.html#handle-native-key-down)
and the [composition key state](https://www.w3.org/TR/uievents/#keys-during-composition).
It is a native dispatch guard, not evidence of OS keyboard or IME delivery.

Validation is bypassed only by the form's `novalidate` or the actual initiating
submitter's `formnovalidate`. Otherwise the helper admits only proved valid
unconstrained domains and barred controls; it rejects intrinsic/constraint
validation it cannot decide before dispatch. Required radio groups are rejected
conservatively even when their required member is barred. No value-only validity
guess or integer parser is introduced. CSS validity observables remain outside
the checkpoint and must be explicitly rejected rather than approximated.

The runtime submission session owns the form identity, shared Event and copied
deliveries. A per-form guard lasts through validation and listener dispatch;
same-form nested submission is suppressed and another form may submit. Native
Host collection releases its mutable DOM/listener borrow before callbacks.
Nested dispatch freezes the event's element path before callbacks, then copies
the registrations separately when each target and phase is reached. Removing a
registration prevents its invocation; removing and re-adding the same callback
creates a new registration. Additions for a later target or phase can run during
the same event. Internal registration generations distinguish recycled listener
slots, without changing schema 4. The runtime's owned path/registration reads
release all DOM borrows before generated callbacks run. Commit-time focus events
retain the existing schedule's explicit element-listener exclusion.
Physical host callbacks retain their existing task/checkpoint boundaries while
using the same registration identities; removed/recycled slots cannot substitute
a new callback in an already snapshotted host phase.
For physical submission, the generated app also dispatches the frozen element
path through its ordinary task runner. Event-checkpoint schedules keep all
element phases in one task; listener-checkpoint schedules keep a task for each
callback. Each phase still snapshots its registrations only when reached.
Submit dispatch checks the propagation flag at each target/phase entry, as in
the DOM invocation algorithm. `stopPropagation()` permits remaining listeners
in that invocation, but skips later phases even on the same target;
`stopImmediatePropagation()` also skips those remaining listeners. Suppressed
callbacks start no task or microtask checkpoint. Cancellation and completion
still run, so stopping propagation does not retain the form's submission guard.
The runtime's internal `App::dispatch_element_path` interface separates this
selection from scheduling; it introduces no framework branch or IR construct.
Completion releases the guard on every path, then checks cancellation and live
form state. A known disconnected receiver dispatches no event and retains
Chromium's disconnected-form console warning. Removed form identities also
retain a conservative named-descendant shadow boundary before the DOM is freed.
An uncanceled live submission
is an explicit unsupported default, preserving the boundary around navigation,
form-data construction and dialog submission. Reset stays unsupported.

`requestSubmit()` submits from the form itself, without clicking a default
button. Its listeners run synchronously before the caller continues, with no
inserted task or microtask checkpoint. Nested submit has discrete update priority
even inside a timer or continuous handler, restored afterward. The interpreter
must keep its live tree visible during all callbacks and use reusable owned
listener snapshots; its existing nested dispatcher empties the tree and consumes
listeners and cannot be reused unchanged.

SubmitEvent's base interface is Event. Only common Event operations and
`instanceof` are included; `submitter`, React `nativeEvent`, argumented
`requestSubmit`, programmatic control `click()`, custom validity and validation
UI retain diagnostics. Named controls that shadow `requestSubmit`, non-form
receivers, command-invoker Auto buttons, nested/parser-specific forms and
unimplemented validity CSS observables require explicit boundaries.

Acceptance requires equivalent React/Vue/Svelte fixtures covering physical and
implicit activation, canceled clicks, disabled default/no-button blockers,
external/invalid owners, synchronous repeated requests, same-form and cross-form
nesting, removal, validation bypass and retained unsupported defaults. Run the
focused decision/frontend checks, affected browser/native and differential
conformance in both optimization modes, then compiler/workspace verification.
Retain failures; do not rewrite expected states, widen tolerances, force blur or
drop traces. Native probes do not prove OS input delivery.

Normative references: [form submission and implicit submission](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-submission-algorithm),
[requestSubmit](https://html.spec.whatwg.org/multipage/forms.html#dom-form-requestsubmit),
[input states](https://html.spec.whatwg.org/multipage/input.html#the-input-element),
[button Auto state](https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element).
Listener timing follows the DOM Standard's
[target/phase invocation](https://dom.spec.whatwg.org/#concept-event-listener-invoke) and
[event listener invocation](https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke).
