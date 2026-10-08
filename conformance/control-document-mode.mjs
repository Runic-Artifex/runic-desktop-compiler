// Full-document mode controls legacy UA sizing and empty-line struts.
// Replacing a fragment must preserve that mode and author rules must win.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const modes = {
  standards: '<!doctype html>',
  quirks: '',
  limited:
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
};
const contents = {
  input_default: '<input id="control" value="Alpha Beta">',
  textarea_default: '<textarea id="control">Alpha Beta\nSecond line</textarea>',
  textarea_authored:
    '<textarea id="control" style="box-sizing:content-box">Alpha Beta\nSecond line</textarea>',
  textarea_text: '<textarea id="control">Alpha Beta\nSecond line</textarea> Text',
  atomic_only: '<span id="control" class="atomic"></span>',
};
for (const [mode, doctype] of Object.entries(modes)) {
  for (const [kind, content] of Object.entries(contents)) {
    cases[`${mode}_${kind}`] = {
      suite: 'controls',
      doctype,
      region: 'table',
      regions: ['table', 'control'],
      viewports: [
        [420, 180, 1],
        [420, 180, 2],
      ],
      html: `<div id="table">${content}</div><div id="after">After</div>`,
      actions: [{ kind: 'html', selector: '#table', value: content }],
    };
  }
}
await runRenderingCases(
  cases,
  {},
  'control-document-mode',
  `
#table{margin:12px;width:320px;font:32px/60px Test;background:#f4f0e8}
#after{margin:12px;font:16px/20px Test}
input,textarea{width:100px;height:44px;font:16px/20px Test;border:1px solid #567;padding:1px 2px;background:white}
textarea{resize:none}
.atomic{display:inline-block;width:100px;height:44px;background:#567}
`,
);
