import { runRenderingCases } from './harness/rendering.mjs';

const viewports = [
  [420, 300],
  [800, 300],
];
const pane = 'width:300px;height:120px;overflow:auto;scrollbar-width:none;border:2px solid #333';
const scroll = (y, x = 0, selector = '#table') => ({ kind: 'scroll', selector, x, y });
const sticky = 'position:sticky;background:#dde8ff;height:24px';
const cases = {
  scroll_fractional_into_view: {
    html: `<div id="table" data-scroll style="width:300px;height:121.5px;box-sizing:border-box;overflow:auto;scrollbar-width:none;border:2px solid #333">${Array.from({ length: 32 }, (_, i) => `<div ${i === 15 ? 'id="target"' : i === 31 ? 'id="end"' : ''} style="height:23.25px;box-sizing:border-box;border-bottom:1px solid #ddd">Item ${i}</div>`).join('')}</div>`,
    viewports: [[420, 300, 1], [420, 300, 2], [800, 300, 1], [800, 300, 2]],
    actions: [
      scroll(0.5),
      { kind: 'scrollIntoView', selector: '#target', block: 'nearest' },
      { kind: 'scrollIntoView', selector: '#target', block: 'start' },
      { kind: 'scrollIntoView', selector: '#end', block: 'center' },
      { kind: 'scrollIntoView', selector: '#end', block: 'end' },
    ],
  },
  scroll_transformed_target: {
    html: `<div id="table" data-scroll style="${pane}"><div style="height:100px">Before</div><div id="target" style="height:20px;transform:translateY(50px);background:#dde8ff">Target</div><div style="height:300px">After</div></div>`,
    viewports,
    regions: ['target'],
    actions: [
      { kind: 'scrollIntoView', selector: '#target', block: 'start' },
      {
        kind: 'attribute',
        selector: '#target',
        name: 'style',
        value: 'height:20px;transform:scaleY(2);background:#dde8ff',
      },
      { kind: 'scrollIntoView', selector: '#target', block: 'end' },
    ],
  },
  scroll_anchor_removed: {
    html: `<div id="table" data-scroll style="${pane}"><div style="height:100px">Before</div><div id="target" style="height:40px">Anchor</div><div style="height:300px">After</div></div>`,
    viewports,
    actions: [
      scroll(100),
      { kind: 'attribute', selector: '#target', name: 'style', value: 'display:none' },
    ],
  },
  scroll_anchor_hidden: {
    html: `<div id="table" data-scroll style="${pane};overflow:hidden"><div id="before" style="height:80px">Before</div><div id="target" style="height:300px">Content</div></div>`,
    viewports,
    actions: [
      scroll(100),
      { kind: 'attribute', selector: '#before', name: 'style', value: 'height:120px' },
    ],
  },
  scroll_anchor_dom_removal: {
    html: `<div id="table" data-scroll style="${pane}"><div style="height:100px">Before</div><div id="target" style="height:40px">Anchor</div><div style="height:300px">After</div></div>`,
    viewports,
    actions: [
      scroll(100),
      {
        kind: 'html',
        selector: '#table',
        value: '<div style="height:100px">Before</div><div style="height:300px">After</div>',
      },
    ],
  },
  sticky_root: {
    standards: true,
    html: `<div id="table" style="height:800px"><div style="height:80px">Before</div><div id="sticky" style="${sticky};top:12px">Root header</div></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(150, 0, 'html'), scroll(600, 0, 'html'), scroll(0, 0, 'html')],
  },
  sticky_oversize: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="height:400px"><div style="height:40px">Before</div><div id="sticky" style="${sticky};height:160px;top:10px;bottom:8px;margin:5px 0">Oversized header</div></section><div style="height:100px">After</div></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(100), scroll(350)],
  },
  sticky_rounded_clip: {
    html: `<div id="table" data-scroll style="${pane};border-radius:18px"><section id="section" style="height:400px"><div id="sticky" style="${sticky};top:0;z-index:2;height:50px">Clipped header</div></section></div>`,
    viewports,
    regions: ['sticky'],
    actions: [
      scroll(90),
      {
        kind: 'attribute',
        selector: '#table',
        name: 'style',
        value: `${pane};border-radius:28px;transform:translate(15px,12px)`,
      },
    ],
  },
  scroll_margin_padding: {
    html: `<div id="table" data-scroll style="${pane};scroll-padding:10% 18px"><div style="height:200px">Before</div><div id="target" style="height:30px;background:#dde8ff;scroll-margin:9px 0 15px">Target</div><div style="height:200px">After</div></div>`,
    viewports,
    regions: ['target'],
    actions: [
      { kind: 'scrollIntoView', selector: '#target', block: 'start' },
      { kind: 'scrollIntoView', selector: '#target', block: 'end' },
      { kind: 'scrollIntoView', selector: '#target', block: 'nearest' },
    ],
  },
  scroll_anchor_opt_out: {
    html: `<div id="table" data-scroll style="${pane};overflow-anchor:none"><div id="before" style="height:80px">Before</div><div id="target" style="height:300px">Content</div></div>`,
    viewports,
    actions: [
      scroll(100),
      { kind: 'attribute', selector: '#before', name: 'style', value: 'height:120px' },
    ],
  },
  scroll_anchor_sibling: {
    html: `<div id="table" data-scroll style="${pane}"><div id="before" style="height:80px">Before</div><div id="target" style="height:300px">Content</div></div>`,
    viewports,
    actions: [
      scroll(100),
      { kind: 'attribute', selector: '#before', name: 'style', value: 'height:120px' },
    ],
  },
  sticky_top: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="height:300px"><div style="height:40px">Before</div><div id="sticky" style="${sticky};top:8px">Header</div></section><div style="height:100px">After</div></div>`,
    viewports,
    actions: [
      scroll(60),
      scroll(280),
      { kind: 'attribute', selector: '#section', name: 'style', value: 'height:240px' },
      scroll(0),
    ],
  },
  sticky_bottom: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="height:300px"><div style="height:200px">Before</div><div id="sticky" style="${sticky};bottom:6px">Footer</div></section><div style="height:100px">After</div></div>`,
    viewports,
    actions: [scroll(100), scroll(280), scroll(0)],
  },
  sticky_axes: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="width:600px;height:300px"><div style="height:60px">Before</div><div id="sticky" style="${sticky};width:80px;margin-left:100px;left:10px;top:10px">Both</div></section></div>`,
    viewports,
    actions: [scroll(80, 150), scroll(180, 300)],
  },
  sticky_rtl: {
    html: `<div id="table" data-scroll dir="rtl" style="${pane}"><section id="section" style="width:600px;height:300px"><div style="height:60px">Before</div><div id="sticky" style="${sticky};width:80px;margin-right:100px;right:10px;top:10px">Right</div></section></div>`,
    viewports,
    actions: [scroll(80, -150), scroll(180, -300)],
  },
  sticky_nested: {
    html: `<div id="outer" data-scroll style="width:340px;height:180px;overflow:auto;scrollbar-width:none"><div style="height:80px">Before</div><div id="table" data-scroll style="${pane}"><section id="section" style="height:400px"><div id="sticky" style="${sticky};top:0">Nested header</div></section></div><div style="height:200px">After</div></div>`,
    viewports,
    actions: [scroll(50, 0, '#outer'), scroll(80), scroll(300)],
  },
  sticky_table: {
    html: `<div id="pane" data-scroll style="${pane}"><table id="table" style="border-spacing:0;width:100%"><caption id="caption">Data</caption><thead id="head"><tr id="header"><th id="sticky" style="position:sticky;top:0;background:#dde8ff">Key</th><th>Value</th></tr></thead><tbody id="body">${Array.from({ length: 12 }, (_, i) => `<tr id="row${i}"><td>${i}</td><td>Entry</td></tr>`).join('')}</tbody></table></div>`,
    viewports,
    actions: [
      scroll(60, 0, '#pane'),
      scroll(250, 0, '#pane'),
      { kind: 'html', selector: '#caption', value: 'Longer caption<br>with two lines' },
    ],
  },
  // CSS compatibility slice 1: what the shadcn-svelte site, Bootstrap and
  // data tables need from sticky positioning, beyond the reductions above.
  sticky_padding: {
    html: `<div id="table" data-scroll style="${pane};padding:14px 10px 18px"><section id="section" style="height:300px"><div style="height:40px">Before</div><div id="sticky" style="${sticky};top:0">Padded top</div><div style="height:150px">Middle</div><div id="end" style="${sticky};bottom:0">Padded bottom</div></section><div style="height:100px">After</div></div>`,
    viewports,
    regions: ['sticky', 'end'],
    actions: [scroll(30), scroll(90), scroll(230)],
  },
  sticky_percent: {
    html: `<div id="table" data-scroll style="${pane};padding:10px"><section id="section" style="height:400px;width:500px"><div style="height:40px">Before</div><div id="sticky" style="${sticky};width:90px;top:10%;left:5%">Percent</div></section></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(70, 40), scroll(200, 120)],
  },
  sticky_margins: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="height:200px;padding:6px;border:3px solid #999"><div style="height:30px">Before</div><div id="sticky" style="${sticky};top:4px;margin:12px 20px 16px">Margins</div><div style="height:40px">Below</div></section><div style="height:200px">After</div></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(40), scroll(120), scroll(170), scroll(210)],
  },
  sticky_flex_grid: {
    html: `<div id="table" data-scroll style="${pane}"><div id="row" style="display:flex;gap:8px;align-items:flex-start"><div id="sticky" style="${sticky};top:6px;width:80px">Flex</div><div style="height:300px;flex:1">Tall</div><div id="stretch" style="position:sticky;top:6px;width:40px;background:#fde">S</div></div><div id="grid" style="display:grid;grid-template-columns:90px 1fr;gap:6px"><div id="cell" style="position:sticky;top:10px;align-self:start;height:30px;background:#dfe">Grid</div><div style="height:260px">Tall cell</div></div><div style="height:120px">After</div></div>`,
    viewports,
    regions: ['sticky', 'stretch', 'cell'],
    actions: [scroll(100), scroll(260), scroll(420)],
  },
  sticky_thead: {
    html: `<div id="pane" data-scroll style="${pane}"><table id="table" style="border-collapse:separate;border-spacing:0;width:420px"><thead id="sticky" style="position:sticky;top:0;background:#dde8ff"><tr id="header"><th id="corner" style="position:sticky;left:0;background:#bcd">Key</th><th>Alpha</th><th>Beta</th><th>Gamma</th></tr></thead><tbody>${Array.from({ length: 10 }, (_, i) => `<tr id="row${i}"><th id="first${i}" style="position:sticky;left:0;background:#eee">Row ${i}</th><td>${i * 11}</td><td>${i * 23}</td><td>${i * 37}</td></tr>`).join('')}</tbody></table></div>`,
    viewports,
    regions: ['sticky', 'corner'],
    actions: [scroll(50, 0, '#pane'), scroll(80, 90, '#pane'), scroll(400, 400, '#pane')],
  },
  sticky_thead_collapse: {
    // shadcn-svelte's data table: a sticky header row group with a
    // background in a collapsed-border table whose rows have bottom borders.
    html: `<div id="pane" data-scroll style="${pane}"><table id="table" style="border-collapse:collapse;width:100%"><thead id="sticky" style="position:sticky;top:0;z-index:10;background:#dde8ff"><tr id="header" style="border-bottom:1px solid #889"><th>Key</th><th>Value</th></tr></thead><tbody>${Array.from({ length: 10 }, (_, i) => `<tr id="row${i}" style="border-bottom:1px solid #ccd"><td>${i}</td><td>Entry ${i}</td></tr>`).join('')}</tbody></table></div>`,
    viewports,
    regions: ['sticky', 'pane'],
    actions: [scroll(45, 0, '#pane'), scroll(130, 0, '#pane')],
  },
  sticky_transformed: {
    html: `<div id="frame" style="margin:20px 0 0 30px;width:310px;transform:rotate(3deg) scale(1.2);transform-origin:0 0"><div id="table" data-scroll style="${pane}"><section id="section" style="height:300px"><div style="height:40px">Before</div><div id="sticky" style="${sticky};top:8px;left:4px;width:150px">Transformed</div></section><div style="height:100px">After</div></div></div>`,
    viewports,
    regions: ['frame'],
    actions: [scroll(60), scroll(200)],
  },
  sticky_no_overflow: {
    html: `<div id="table" data-scroll style="${pane}"><div style="height:10px"></div><div id="sticky" style="${sticky};top:20px">No overflow</div><div id="low" style="${sticky};bottom:30px">Bottom</div></div>`,
    viewports,
    regions: ['sticky', 'low'],
    actions: [],
  },
  sticky_in_sticky: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="height:500px"><div style="height:20px">Before</div><div id="outer-sticky" style="position:sticky;top:4px;height:90px;background:#eef"><div style="height:30px">Head</div><div id="sticky" style="${sticky};top:10px">Inner</div></div><div style="height:300px">Middle</div></section></div>`,
    viewports,
    regions: ['outer-sticky'],
    actions: [scroll(40), scroll(150), scroll(420)],
  },
  sticky_negative_bottom: {
    html: `<div id="table" data-scroll style="${pane}"><div style="height:300px">Links</div><div id="sticky" style="${sticky};bottom:-4px;height:24px;opacity:.9">Fade</div></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(60), scroll(200)],
  },
  sticky_right: {
    html: `<div id="table" data-scroll style="${pane};white-space:nowrap"><span style="display:inline-block;width:500px">Chips</span><span id="sticky" style="position:sticky;right:0;display:inline-block;width:60px;background:#fdd">End</span></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(0, 120), scroll(0, 400)],
  },
  sticky_fractional: {
    html: `<div id="table" data-scroll style="${pane}"><section id="section" style="height:300.5px"><div style="height:40.25px">Before</div><div id="sticky" style="${sticky};top:7.5px">Fractional</div></section><div style="height:100px">After</div></div>`,
    viewports,
    regions: ['sticky'],
    actions: [scroll(60.5), scroll(150.75), scroll(277.25)],
  },
  scroll_into_view: {
    html: `<div id="outer" data-scroll style="width:340px;height:180px;overflow:auto;scrollbar-width:none"><div style="height:100px">Before</div><div id="table" data-scroll style="${pane}"><div style="height:220px">Before</div><div id="target" style="height:30px;background:#dde8ff">Target</div><div style="height:120px">After</div></div><div style="height:200px">After</div></div>`,
    viewports,
    actions: [
      { kind: 'scrollIntoView', selector: '#target', block: 'nearest' },
      { kind: 'scrollIntoView', selector: '#target', block: 'start' },
      { kind: 'scrollIntoView', selector: '#target', block: 'end' },
    ],
  },
  scroll_absolute: {
    html: `<div id="table" data-scroll style="${pane};position:relative"><div id="target" style="position:absolute;left:420px;top:250px;width:50px;height:30px;background:#dde8ff">Far</div><div id="negative" style="position:absolute;left:-50px;top:-40px;width:20px;height:20px"></div></div>`,
    viewports,
    actions: [scroll(10000, 10000)],
  },
};
for (const value of Object.values(cases)) value.suite = 'scrolling';
await runRenderingCases(cases, {}, 'scrolling', 'td,th{padding:4px}th{font-weight:normal}');
