// Nested inline alignment: direct/textless ancestors, leading, line placement and atomics.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const baseStyle = 'margin:20.375px;width:178px;font:16px/20px Test';

function add(name, content, style = baseStyle, mutation = `${baseStyle};font-size:20px`) {
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'outer', 'inner'],
    viewports,
    html: `<div id="table" data-font-metrics style="${style}">${content}<span style="font-size:32px"> Tall</span></div>`,
    actions: [{ kind: 'style', selector: '#table', value: mutation }],
  };
}

add(
  'direct_baseline_middle',
  'Before <span id="outer" data-client-rects style="vertical-align:baseline">Outer <span id="inner" data-client-rects style="vertical-align:middle">Inner</span></span> after',
);
add(
  'direct_middle_length',
  'Before <span id="outer" data-client-rects style="vertical-align:middle">Outer <span id="inner" data-client-rects style="vertical-align:3px">Inner</span></span> after',
);
add(
  'direct_length_baseline',
  'Before <span id="outer" data-client-rects style="vertical-align:3px">Outer <span id="inner" data-client-rects style="vertical-align:baseline">Inner</span></span> after',
);
add(
  'textless_baseline_middle',
  'Before <span id="outer" data-client-rects style="vertical-align:baseline"><span id="inner" data-client-rects style="vertical-align:middle">Inner</span></span> after',
);
add(
  'textless_middle_length',
  'Before <span id="outer" data-client-rects style="vertical-align:middle"><span id="inner" data-client-rects style="vertical-align:3px">Inner</span></span> after',
);
add(
  'negative_leading',
  'Before <span id="outer" data-client-rects style="vertical-align:3px">Outer <span id="inner" data-client-rects style="vertical-align:middle">Inner</span></span> after',
  'margin:20.375px;width:178px;font:20px/12px Test',
  'margin:20.375px;width:178px;font:24px/12px Test',
);
add(
  'positive_leading',
  'Before <span id="outer" data-client-rects style="vertical-align:middle">Outer <span id="inner" data-client-rects style="vertical-align:baseline">Inner</span></span> after',
  'margin:20.375px;width:178px;font:12px/36px Test',
  'margin:20.375px;width:178px;font:16px/36px Test',
);
add(
  'top_ancestor',
  'Before <span id="outer" data-client-rects style="vertical-align:top">Outer <span id="inner" data-client-rects style="vertical-align:middle">Inner</span></span> after',
);
add(
  'bottom_ancestor',
  'Before <span id="outer" data-client-rects style="vertical-align:bottom">Outer <span id="inner" data-client-rects style="vertical-align:3px">Inner</span></span> after',
);
add(
  'wrapped_lines',
  'Before <span id="outer" data-client-rects style="vertical-align:middle">Alpha <span id="inner" data-client-rects style="vertical-align:3px">Beta Gamma</span> Delta Epsilon</span> after',
  'margin:20.375px;width:112px;font:16px/20px Test',
  'margin:20.375px;width:84px;font:20px/20px Test',
);
add(
  'atomic_nested_child',
  'Before <span id="outer" data-client-rects style="vertical-align:middle">Outer <i id="inner" data-client-rects style="display:inline-block;width:17px;height:23px;vertical-align:3px;background:#abc"></i></span> after',
);
add(
  'empty_ancestor_following_text',
  'Before <span id="outer" data-client-rects style="vertical-align:middle"><span id="inner" data-client-rects style="vertical-align:3px"></span></span> following text',
);

await runRenderingCases(cases, {}, 'nested-alignment', '#table{background:#f4f0e8;color:#234}');
