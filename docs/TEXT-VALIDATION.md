# Typed text validation

Phase 2 adds a limited open text domain to IR schema 3. The compiler-owned validation model is separate from browser/native conformance traces. See [ir.mjs](../compiler/ir.mjs) and [phase2.test.mjs](../tests/phase2.test.mjs).

## Domain and input boundary

One text slot may declare `{kind: "text", maxUtf16: 256}`. Values contain Unicode scalars, exclude C0 controls and DEL, and have at most 256 UTF-16 code units. Empty text is valid. Lone surrogates, tabs, newlines, wrong types and excessive lengths fail with `E_TEXT_PAYLOAD`. Finite string enums retain their separate domain and limits.

A `text-input` handler receives one string payload and copies it directly to the slot bound to an unconditional text input. The control declares `type="text"`, `maxlength=256`, a live value and optional disabled/read-only properties. Click handlers receive no payload. Serialized IR cannot read a payload outside its handler, attach it to another control or transform it arbitrarily.

Both the IR interpreter and generated Rust validate payloads before updating state. The native binding guards locked edits and oversized character-key edits before Blitz changes the editor. A rejected delivered payload reports an error and restores the committed live value. Clipboard/paste truncation and platform IME boundary behavior are outside the verified contract; rollback is not a certification of those routes.

## Supported observations and operations

Open text supports escaped text rendering, live input values, copy/replacement, literal reset, same-type selection, comparison with the empty string and UTF-16 `.length`. It cannot become an arbitrary class/title attribute or be compared with a nonempty string or another open string. Concatenation, substring, indexing, normalization, regular expressions and general string methods are rejected.

Rust uses `encode_utf16().count()`: `"😀".length` and `"e\u0301".length` are both 2; `"é".length` is 1. Editor cursor byte offsets are converted to UTF-16 units for traces. Byte lengths and grapheme counts are not substituted for JavaScript length.

IR also defines `boolean-text`, producing `"true"` or `"false"`. Vue interpolation uses that operation. React boolean children lower to non-rendering boolean parts. The backend implements explicit operations rather than selecting behavior by framework name.

## Why length classes suffice

Project text to its UTF-16 length and retain every finite control value. There are 257 possible text lengths. The validator checks the grammar, then explores the projected state machine exactly, including all 257 payload lengths at each input transition. The 4,096 reachable-state limit applies to projected states too.

The grammar makes this projection sufficient for control behavior:

- Copy preserves source length; literal replacement has a known length.
- Empty comparison depends only on whether length is zero.
- Length returns the projected integer exactly.
- Numeric/boolean guards and selections choose the same branches throughout a length class.
- Ordered writes preserve these properties, including captured reads and intermediate numeric bounds.

The implementation executes an ASCII representative for each length **after** establishing those restrictions. Representatives do not establish the restrictions. `text === "secret"` is rejected even if representative executions pass. Transferring open text into a finite enum must still satisfy that enum's exact domain rules.

Rendering retains the actual string. Direct copy/escaping have their own Rust lowering; accepted source cannot read rendered text back into its logic. The proof establishes totality, input/state bounds, supported observations and transition closure. It does not prove every Unicode string's CSS/rasterization parity or certify platform input delivery.

Finite applications return every exact BFS edge. Text validation returns projected counts and a streamed transition hash labelled `length-quotient-v1`; it does not return fictional exhaustive string traces. Browser scenarios, native Unicode witnesses and pixels are additional evidence.

## Extension rule

A new operation needs a semantic definition, an abstraction preserving its observations, a checker rule and a Rust implementation. More samples or a larger BFS limit cannot make an unsupported operation sound. More text slots, richer events, asynchronous effects and editor APIs require separate contracts.
