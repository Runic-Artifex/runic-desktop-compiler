// `CSS.supports(property, value)` of build-time constant arguments
// (frontend/language.ts, bits-ui's PinInput
// `window?.CSS?.supports("-webkit-touch-callout", "none")`).
//
// The program behaves as it does in the reference browser, so the answer is
// Chromium 153's, measured by conformance/css-supports.mjs (which fails where
// Chromium answers otherwise). It is given only where the native renderer
// agrees: `native` is whether Stylo, with Blitz's preferences, parses the
// declaration (runic_css::check::declaration_parses, checked by
// tests/slider-pin-input.test.mjs). Where the two differ, code taking Chromium's
// branch would rely on a declaration the native app drops (or skip one it
// renders), so the call is rejected rather than answered.

/** A measured declaration: Chromium's answer and the native renderer's. */
export interface Supports {
  chromium: boolean;
  native: boolean;
}

/** The declarations measured, keyed `property: value`. */
export const CSS_SUPPORTS: Record<string, Supports> = {
  // An iOS Safari property: neither Chromium nor Stylo knows it.
  '-webkit-touch-callout: none': { chromium: false, native: false },
};

/** The key of a declaration in `CSS_SUPPORTS`. */
export const supportsKey = (property: string, value: string): string => `${property}: ${value}`;
