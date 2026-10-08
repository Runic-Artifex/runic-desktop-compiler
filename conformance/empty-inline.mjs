// Empty inline boxes retain their own font area without introducing text or shaping seams.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const base = 'margin:20.375px;width:178px;font:16px/20px Test';
const span = (content = '', style = 'vertical-align:3px') =>
  `<span id="inner" data-client-rects style="${style}">${content}</span>`;
function add(name, content, style = base, mutation = `${base};font-size:20px`) {
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'inner'],
    viewports,
    html: `<div id="table" style="${style}">${content}</div>`,
    actions: [{ kind: 'style', selector: '#table', value: mutation }],
  };
}
add('between_text', `Before ${span()} after`);
add('leading', `${span()}Following text`);
add('trailing', `Before text${span()}`);
add('sole', span());
add('collapsed_sole', span('   '));
add('collapsed_between', `Before ${span('   ')} after`);
add('pending_space', `Before ${span()}after`);
add('before_space', `Before${span()} after`);
add('nested', `Before <span id="outer" data-client-rects style="vertical-align:middle">${span()}</span> after`);
add('larger_font', `Before ${span('', 'font-size:32px;vertical-align:middle')} after`);
add('top', `Before ${span('', 'font-size:32px;vertical-align:top')} after`);
add('bottom', `Before ${span('', 'font-size:32px;vertical-align:bottom')} after`);
add('wrap_boundary', `Alpha beta ${span()}Gamma delta`, `${base};width:84px`, `${base};width:104px;font-size:20px`);
add('before_break', `Before${span()}<br>After`);
add('after_break', `Before<br>${span()}After`);
add('rtl', `قبل ${span()} بعد`, `${base};direction:rtl`, `${base};direction:rtl;font-size:20px`);
add('mixed_bidi', `Before אבג${span()}דהו after`);
add('contents', `Before <span id="inner" data-client-rects style="display:contents;vertical-align:3px"></span> after`);

await runRenderingCases(cases, {}, 'empty-inline', '#table{background:#f4f0e8;color:#234}');
