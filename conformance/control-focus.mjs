// Pinned text-control paint, with editor state observed independently of pixels.
// Selection actions accept UTF-16 scalar boundaries; mid-surrogate offsets fail.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
const variants = {
  input: '<input id="control" value="Alpha Beta">',
  textarea: '<textarea id="control">Alpha Beta\nSecond line</textarea>',
  readonly: '<input id="control" readonly value="Alpha Beta">',
  disabled: '<input id="control" disabled value="Alpha Beta">',
  placeholder: '<input id="control" placeholder="Type a name">',
  author_outline:
    '<input id="control" value="Alpha Beta" style="outline:2px solid #a30;outline-offset:3px">',
  auto_outline:
    '<input id="control" value="Alpha Beta" style="outline:auto 1px #a30;outline-offset:3px;border-radius:8px">',
  unicode: '<input id="control" value="A🙂 Beta">',
};
for (const [name, control] of Object.entries(variants)) {
  cases[name] = {
    suite: 'controls',
    standards: true,
    browserStyleRequirements: [
      { selector: '#control', property: 'caretAnimation', value: 'manual' },
    ],
    region: 'table',
    regions: ['table', 'control'],
    viewports: [
      [360, 160, 1],
      [360, 160, 2],
    ],
    html: `<div id="table">${control}<button id="other">Other</button></div>`,
    actions: [
      { kind: 'focus', selector: '#control' },
      { kind: 'selection', selector: '#control', start: 0, end: 100 },
      { kind: 'selection', selector: '#control', start: 1, end: name === 'unicode' ? 3 : 5 },
      { kind: 'selection', selector: '#control', start: 0, end: 0 },
      { kind: 'focus', selector: '#other' },
    ],
  };
}
// Keep the standards UA box-model failures above. Explicit boxes isolate paint.
for (const [name, original] of Object.entries(cases)) {
  cases[`${name}_boxed`] = {
    ...original,
    html: original.html
      .replace(/<(input|textarea)(?=\s)/, '<$1 style="box-sizing:border-box"')
      .replace(
        '<button id="other">',
        '<button id="other" style="border:1px solid #567;padding:1px 6px">',
      ),
  };
  // Preserve authored style instead of adding a duplicate HTML style attribute.
  if (original.html.includes(' style="')) {
    cases[`${name}_boxed`].html = original.html
      .replace(' style="', ' style="box-sizing:border-box;')
      .replace(
        '<button id="other">',
        '<button id="other" style="border:1px solid #567;padding:1px 6px">',
      );
  }
}
// Effect/clip reductions use the same explicit control boxes, alongside the UA cases.
for (const [name, style] of Object.entries({
  overflow_hidden: 'overflow:hidden',
  opacity_filter: 'opacity:.6;filter:blur(.2px)',
  clip_path: 'clip-path:inset(-3px 0 -3px 0)',
  mask: 'mask-image:linear-gradient(to right,black 60%,transparent)',
  negative_outline: 'outline:auto 1px #a30;outline-offset:-5px',
})) {
  cases[name] = {
    ...cases.input_boxed,
    html: cases.input_boxed.html.replace(
      'style="box-sizing:border-box"',
      `style="box-sizing:border-box;${style}"`,
    ),
  };
}
await runRenderingCases(
  cases,
  {},
  'control-focus',
  `
#table{margin:12px;padding:4px;width:260px;background:#f4f0e8}
input,textarea,button{font:16px/20px Test;color:#234}
input,textarea{caret-animation:manual;width:180px;background:white;border:1px solid #567;padding:1px 2px}
textarea{height:52px;resize:none}
button{margin-left:8px}
`,
);
