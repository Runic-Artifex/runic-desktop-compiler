// Native-control oracle. The pinned cases isolate layout and painting from
// host fonts; control_ua_font_gap deliberately leaves UA font selection alone.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {
  control_checkbox_native_author: {
    suite: 'controls',
    region: 'table',
    regions: ['checked', 'unchecked'],
    html: `<div id="table" class="pinned"><input id="checked" type="checkbox" checked style="width:24px;height:18px;padding:8px;border:5px solid red;background:yellow;vertical-align:top"><input id="unchecked" type="checkbox" style="width:31px;height:22px;padding:7px;border:4px solid green;background:orange;vertical-align:top"></div>`,
  },
  control_checkbox_appearance_none: {
    suite: 'controls',
    region: 'table',
    regions: ['checked', 'unchecked'],
    html: `<div id="table" class="pinned"><input id="checked" type="checkbox" checked style="appearance:none;width:24px;height:18px;padding:3px;border:2px solid red;background:yellow;border-radius:4px;vertical-align:top"><input id="unchecked" type="checkbox" style="appearance:none;width:31px;height:22px;padding:4px;border:3px solid green;background:orange;vertical-align:top"></div>`,
  },
  control_radio_native_author: {
    suite: 'controls',
    region: 'table',
    regions: ['checked', 'unchecked'],
    html: `<div id="table" class="pinned"><input id="checked" type="radio" checked style="width:23px;height:19px;padding:8px;border:5px solid red;background:yellow;vertical-align:top"><input id="unchecked" type="radio" style="width:30px;height:21px;padding:7px;border:4px solid green;background:orange;vertical-align:top"></div>`,
  },
  control_input_auto_min_flex: {
    suite: 'controls',
    region: 'table',
    regions: ['input', 'side'],
    html: `<div id="table" class="pinned" style="display:flex;width:180px"><input id="input" value="A long value intended to measure the automatic minimum" style="flex:1 1 auto"><span id="side">Side</span></div>`,
  },
  control_input_intrinsic_sizes: {
    suite: 'controls',
    region: 'table',
    regions: ['size10', 'size20', 'size30', 'width'],
    html: `<div id="table" class="pinned"><input id="size10" size="10"><input id="size20" size="20"><input id="size30" size="30"><input id="width" size="30" style="width:132px"></div>`,
  },
  control_input_size_zero: {
    suite: 'controls',
    region: 'table',
    regions: ['zero', 'default'],
    html: `<div id="table" class="pinned"><input id="zero" size="0"><input id="default"></div>`,
  },
  control_textarea_overflow: {
    suite: 'controls',
    region: 'area',
    regions: ['area'],
    html: `<div id="table" class="pinned"><textarea id="area" data-scroll rows="2" cols="8" style="width:80px;height:42px;overflow:auto">A very long textarea line which overflows its content box and must scroll</textarea></div>`,
    actions: [{ kind: 'scroll', selector: '#area', x: 0, y: 100 }],
  },
  // This records a real packaging gap: the probe disables system-font lookup,
  // while Chromium's UA control font is host-provided. It is not a control
  // geometry target and remains visible rather than being hidden by Test.
  control_ua_font_gap: {
    suite: 'controls',
    region: 'table',
    html: `<div id="table"><button id="button">Save</button><input id="input" value="Edit text"></div>`,
  },
};

await runRenderingCases(
  cases,
  {},
  'controls',
  '#table{font:16px/20px Test}#table.pinned input,#table.pinned textarea,#table.pinned button{font:inherit}',
);
