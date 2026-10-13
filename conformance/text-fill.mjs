// Text fill colours and backgrounds clipped to text (CSS slice 2: the
// shadcn-svelte `shimmer` utility, background-clip: text with a transparent
// -webkit-text-fill-color), against Chromium.
// (Underline colours are checked where the fill hides them: Blitz draws
// underlines a device pixel higher than Chromium, a separate gap.)
import { runRenderingCases } from './harness/rendering.mjs';

const viewports = [
  [420, 300],
  [800, 300],
];
const gradient =
  'background-image:linear-gradient(110deg,#222 40%,#d0d0d0 50%,#222 60%);background-size:calc(200% + 80px) 100%;background-repeat:no-repeat';
const shimmer = `${gradient};background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent`;
const cases = {
  text_fill_color: {
    html: `<p id="fill" style="margin:10px;font-size:24px;color:#c00;-webkit-text-fill-color:#036">Filled text, red colour</p><p id="clear" style="margin:10px;font-size:24px;color:#c00;-webkit-text-fill-color:transparent;text-decoration:underline">Transparent fill</p><p id="inherit" style="margin:10px;font-size:20px;-webkit-text-fill-color:green">Parent <span id="span" style="color:#c00">child keeps the fill</span> <span id="own" style="-webkit-text-fill-color:currentColor;color:#00c">own current</span></p>`,
    viewports,
    regions: ['fill', 'clear', 'inherit'],
  },
  clip_text_gradient: {
    html: `<p id="t" style="margin:10px;font-size:28px;${shimmer};background-position:30% 0">Generating response…</p><p id="end" style="margin:10px;font-size:28px;${shimmer};background-position:100% 0">Generating response…</p><p id="start" style="margin:10px;font-size:28px;${shimmer};background-position:0 0">Generating response…</p>`,
    viewports,
    regions: ['t', 'end', 'start'],
  },
  clip_text_box: {
    html: `<p id="pad" style="margin:10px;padding:8px 14px;border:3px solid #999;font-size:24px;background-color:#c60;background-clip:text;-webkit-text-fill-color:transparent">Colour through text</p><p id="mixed" style="margin:10px;font-size:24px;${gradient};background-clip:text;-webkit-text-fill-color:rgba(0,0,0,.3);background-position:40% 0">Half transparent fill</p>`,
    viewports,
    regions: ['pad', 'mixed'],
  },
  clip_text_flex_item: {
    html: `<div id="row" style="display:flex;gap:8px;align-items:center;margin:10px;font-size:16px"><span id="icon" style="width:16px;height:16px;background:#888"></span><span id="marker" style="min-width:0;${shimmer};background-position:60% 0">Thinking...</span></div><div id="sep" style="display:flex;margin:10px;font-size:16px"><span id="m2" style="${shimmer};background-position:20% 0">Reading 4 files</span></div>`,
    viewports,
    regions: ['row', 'sep'],
  },
  clip_text_ellipsis: {
    html: `<p id="title" style="display:block;max-width:150px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:10px;font-size:16px;${shimmer};background-position:50% 0">quarterly-report-final.pdf</p>`,
    viewports,
    regions: ['title'],
  },
  clip_text_rtl: {
    html: `<p id="rtl" dir="rtl" style="margin:10px;font-size:24px;${shimmer};background-position:30% 0">Generating response…</p><p id="wrap" style="margin:10px;width:180px;font-size:20px;${shimmer};background-position:70% 0">A longer line that wraps onto three lines here</p>`,
    viewports,
    regions: ['rtl', 'wrap'],
  },
  clip_text_decoration: {
    html: `<p id="u" style="margin:10px;font-size:24px;color:#c00;text-decoration:underline;${shimmer};background-position:30% 0">Underlined shimmer</p>`,
    viewports,
    regions: ['u'],
  },
};
// The harness crops to `#table`.
for (const value of Object.values(cases)) {
  value.suite = 'text-fill';
  value.html = `<div id="table" style="display:flow-root">${value.html}</div>`;
}
await runRenderingCases(cases, {}, 'text-fill');
