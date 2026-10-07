// Direct table and shared-paint oracle. Cases stay independent of framework syntax.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {
  auto: '<table id="table"><tbody id="body"><tr id="row"><td id="a">Hi</td><td id="b">A much longer column</td></tr><tr id="row2"><td>three words here</td><td>Short</td></tr></tbody></table>',
  wide: '<table id="table" style="width:500px"><tr id="row"><td id="a">Hi</td><td id="b">A much longer column</td></tr></table>',
  narrow:
    '<table id="table" style="width:180px"><tr id="row"><td id="a">three words here</td><td id="b">A much longer column</td></tr></table>',
  caption:
    '<table id="table" style="border:3px solid #246;background:#eee"><caption id="caption">A table caption</caption><tbody id="body"><tr id="row"><td id="a">Hi</td><td id="b">Long column</td></tr></tbody></table><div id="after">After</div>',
  bottom:
    '<table id="table" style="border:2px solid #246"><caption id="caption" style="caption-side:bottom">Bottom caption</caption><tr id="row"><td id="a">Hello</td><td>world</td></tr></table><div id="after">After</div>',
  align:
    '<table id="table"><tr id="row"><td id="a"><div id="inside">one</div></td><td id="b">two<br>lines<br>here</td><td style="vertical-align:bottom"><div id="bottom">bottom</div></td><td style="vertical-align:top"><div id="top">top</div></td></tr></table>',
  groups:
    '<table id="table"><tfoot id="foot"><tr id="footer"><td>foot</td></tr></tfoot><tbody id="body" style="background:#ddeeff"><tr id="row"><td id="a">body</td></tr><tr id="row2" style="background:#ccffaa"><td>body 2</td></tr></tbody><thead id="head"><tr id="header"><th>head</th></tr></thead></table>',
  spans:
    '<table id="table"><tr id="row"><td id="a" rowspan="2">tall</td><td id="b">wide words</td><td>X</td></tr><tr id="row2"><td id="c" colspan="2">A spanning cell much wider than either one</td></tr><tr id="row3"><td id="d">End</td><td>cell</td><td>last</td></tr></table>',
  fixed:
    '<table id="table" style="table-layout:fixed;width:320px"><colgroup><col style="width:25%"><col></colgroup><tbody id="body"><tr id="row"><td id="a">one</td><td id="b">two</td></tr><tr id="row2"><td>longer content</td><td>rest</td></tr></tbody></table>',
  collapse:
    '<table id="table" style="border-collapse:collapse"><tbody id="body"><tr id="row" style="background:#ddd"><td id="a" style="border:2px solid #333">one</td><td id="b" style="border:2px solid #333">two</td></tr><tr id="row2"><td style="border:2px solid #333">three</td><td style="border:2px solid #333">four</td></tr></tbody></table>',
  baseline:
    '<table id="table"><tr id="row"><td id="a" style="vertical-align:baseline;font-size:24px">Big</td><td id="b" style="vertical-align:baseline">Small</td><td id="c" style="vertical-align:baseline;padding-top:18px">Padded</td></tr></table>',
  percentage:
    '<table id="table" style="width:400px"><tr id="row"><td id="a" style="width:25%">A</td><td id="b">Long words for the remainder</td></tr></table>',
  cellwidth:
    '<table id="table"><tr id="row"><td id="a">a</td><td id="b">b</td></tr><tr id="row2"><td id="c" style="width:150px">x</td><td>y</td></tr></table>',
  rowheight:
    '<table id="table"><tr id="row" style="height:80px"><td id="a"><div id="inside">middle</div></td><td>row</td></tr></table>',
  tableheight:
    '<table id="table" style="height:180px"><tbody id="body"><tr id="row"><td id="a"><div id="inside">a</div></td></tr><tr id="row2"><td id="b"><div id="inside2">b</div></td></tr></tbody></table>',
  empty:
    '<table id="table"><caption id="caption">Empty table</caption></table><div id="after">After</div>',
  inline:
    '<div id="line">Before <table id="table" style="display:inline-table"><tr id="row"><td id="a">one</td><td id="b">two</td></tr></table> after</div>',
  css: '<div id="table" style="display:table"><div id="body" style="display:table-row-group"><div id="row" style="display:table-row"><div id="a" style="display:table-cell;padding:4px">Cell</div><div id="b" style="display:table-cell;padding:4px">Long cell</div></div></div></div>',
  captionmargin:
    '<table id="table" style="border:2px solid black;width:220px"><caption id="caption" style="margin:5px 10px;text-align:left">Caption with a margin</caption><tr id="row"><td id="a">one</td><td>two</td></tr></table><div id="after">After</div>',
  padding:
    '<table id="table" style="padding:8px;border:2px solid black"><tr id="row"><td id="a">one</td><td id="b">two</td></tr></table>',
  colwidth:
    '<table id="table"><colgroup><col style="width:160px"><col style="width:80px"></colgroup><tr id="row"><td id="a">a</td><td id="b">b</td></tr></table>',
  nowrap:
    '<table id="table" style="width:100px"><tr id="row"><td id="a" style="white-space:nowrap">Cannot wrap this</td><td id="b">other words</td></tr></table>',
  collapse_spans:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" rowspan="2" style="border:2px solid black">tall</td><td id="b" style="border:2px solid black">one</td></tr><tr id="row2"><td id="c" style="border:2px solid black">two</td></tr></table>',
  collapse_mixed:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="border:1px solid red">one</td><td id="b" style="border:5px solid blue">two</td></tr><tr id="row2"><td id="c" style="border:3px solid green">three</td><td id="d" style="border:2px solid orange">four</td></tr></table>',

  rtl: '<table id="table" dir="rtl"><tbody id="body"><tr id="row"><td id="a">First</td><td id="b">Long second column</td></tr></tbody></table>',
  collapse_rtl:
    '<table id="table" dir="rtl" style="border-collapse:collapse"><tr id="row"><td id="a" style="border:2px solid red">first</td><td id="b" style="border:4px solid blue">second</td></tr></table>',
  zero_span:
    '<table id="table"><tbody id="body"><tr id="row"><td id="a" rowspan="0">All rows</td><td id="b">one</td></tr><tr id="row2"><td id="c">two</td></tr><tr id="row3"><td id="d">three</td></tr></tbody><tbody id="body2"><tr id="row4"><td id="e">Next group</td><td>row</td></tr></tbody></table>',
  bounded_span:
    '<table id="table"><tbody id="body"><tr id="row"><td id="a" rowspan="8">Clamped</td><td id="b">one</td></tr><tr id="row2"><td id="c">two</td></tr></tbody><tbody id="body2"><tr id="row3"><td id="d">New group</td></tr></tbody></table>',
  fixed_span:
    '<table id="table" style="table-layout:fixed;width:320px"><tr id="row"><td id="a" colspan="2" style="width:200px">spanned</td><td id="b">rest</td></tr><tr id="row2"><td id="c">one</td><td id="d">two</td><td id="e">three</td></tr></table>',
  maxwidth:
    '<table id="table" style="max-width:180px"><tr id="row"><td id="a">Three small words</td><td id="b">Another large column of text</td></tr></table>',
  collapse_hidden:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="border:3px solid red;border-right-style:hidden">one</td><td id="b" style="border:5px solid blue">two</td></tr></table>',
  collapse_rowborder:
    '<table id="table" style="border-collapse:collapse;border:4px solid black"><tr id="row" style="border-bottom:6px solid blue"><td id="a" style="border:1px solid red">one</td><td id="b">two</td></tr><tr id="row2"><td id="c">three</td><td id="d">four</td></tr></table>',
  collapse_styles:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="border:3px double red">one</td><td id="b" style="border:3px dashed blue">two</td></tr><tr id="row2"><td id="c" style="border:3px dotted green">three</td><td id="d" style="border:3px solid black">four</td></tr></table>',
  collapse_fractional:
    '<table id="table" style="border-collapse:collapse;margin-left:.375px;margin-top:.625px"><tr id="row"><td id="a" style="width:35px;height:20px;border:3px solid red"></td><td id="b" style="width:53px;height:20px;border:5px solid blue"></td></tr></table>',
  collapse_dots1:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:1px dotted green"></td><td id="b" style="width:29px;border:1px dotted blue"></td></tr></table>',
  collapse_dots2:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:2px dotted green"></td><td id="b" style="width:29px;border:2px dotted blue"></td></tr></table>',
  collapse_dots4:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:4px dotted green"></td><td id="b" style="width:29px;border:4px dotted blue"></td></tr></table>',
  collapse_dots7:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:7px dotted green"></td><td id="b" style="width:29px;border:7px dotted blue"></td></tr></table>',
  collapse_dots5_fractional:
    '<table id="table" style="border-collapse:collapse;margin-left:.375px;margin-top:.625px"><tr id="row"><td id="a" style="width:47px;height:20px;border:5px dotted green"></td><td id="b" style="width:29px;border:5px dotted blue"></td></tr></table>',
  collapse_dots5_rtl:
    '<table id="table" dir="rtl" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:5px dotted green"></td><td id="b" style="width:29px;border:5px dotted blue"></td></tr></table>',
  collapse_dots5:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:5px dotted green"></td><td id="b" style="width:29px;border:5px dotted blue"></td></tr></table>',
  collapse_bevel:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:6px groove #369"></td><td id="b" style="width:29px;border:6px ridge #369"></td></tr></table>',
  collapse_inset_outset:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:6px inset #369"></td><td id="b" style="width:29px;border:6px outset #369"></td></tr></table>',
  collapse_double_background:
    '<table id="table" style="border-collapse:collapse;background:#eef"><tr id="row"><td id="a" style="width:47px;height:20px;border:3px double red;background:#ffc"></td><td id="b" style="width:29px;border:3px dashed blue;background:#cfc"></td></tr></table>',
  collapse_sparse:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border-top:3px dashed green"></td><td id="b" style="width:29px;border-bottom:2px dotted blue"></td></tr></table>',
  collapse_span_junctions:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" rowspan="2" style="width:47px;border:3px double red"></td><td id="b" style="width:29px;height:20px;border:3px dashed blue"></td></tr><tr id="row2"><td id="c" style="height:20px;border:5px dotted green"></td></tr></table>',
  cellheight:
    '<table id="table"><tr id="row"><td id="a" style="height:60px;padding:8px;border:2px solid red"><div id="inside" style="width:30px;height:10px;background:blue"></div></td><td id="b" style="padding:8px;border:2px solid green"><div style="width:40px;height:20px;background:orange"></div></td></tr></table>',
  cellheight_content:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="height:10px;border:2px solid red"><div id="inside" style="width:30px;height:60px;background:blue"></div></td><td id="b">one<br>two<br>three</td></tr></table>',
  span_height:
    '<table id="table"><tr id="row"><td id="a" rowspan="2" style="height:90px;border:2px solid red"><div id="inside" style="width:30px;height:10px;background:blue"></div></td><td id="b" style="height:20px;width:40px"></td></tr><tr id="row2"><td id="c" style="height:20px"></td></tr></table>',
  percentage_height:
    '<table id="table" style="height:160px"><tr id="row"><td id="a" style="height:50%;border:2px solid red"><div id="inside" style="width:30px;height:10px;background:blue"></div></td></tr><tr id="row2"><td id="b"><div id="inside2" style="width:30px;height:10px;background:green"></div></td></tr></table>',
  collapse_cell_opacity:
    '<table id="table" style="border-collapse:collapse;background:#eef"><tr id="row"><td id="a" style="width:47px;height:20px;border:3px double red;background:#ffc;opacity:.5"></td><td id="b" style="width:29px;border:3px dashed blue;background:#cfc"></td></tr></table>',
  collapse_hidden_cell_background:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;background:red;visibility:hidden"></td><td id="b" style="width:29px;background:green"></td></tr></table>',
  collapse_cell_opacity_content:
    '<table id="table" style="border-collapse:collapse;background:#eef"><tr id="row"><td id="a" style="border:3px double red;background:#ffc;opacity:.5"><div id="inside" style="background:#cfc">Opacity</div></td><td id="b" style="border:3px dashed blue;background:#cfc">Other</td></tr></table>',
  collapse_table_opacity:
    '<table id="table" style="border-collapse:collapse;background:#eef;opacity:.5"><tr id="row"><td id="a" style="width:47px;height:20px;border:3px double red;background:#ffc"></td><td id="b" style="width:29px;border:3px dashed blue;background:#cfc"></td></tr></table>',
  collapse_gradient:
    '<table id="table" style="border-collapse:collapse"><tr id="row"><td id="a" style="width:47px;height:20px;border:3px double red;background:linear-gradient(to right,#ffc,#cfc)"></td><td id="b" style="width:29px;border:3px dashed blue;background:linear-gradient(to bottom,#def,#cef)"></td></tr></table>',
};

// These primitive controls isolate shared painting from the table formatting
// context. "table" is only the region id used by this oracle's crop metric.
Object.assign(cases, {
  border_dots5: '<div id="table" style="width:90px;height:30px;border:5px dotted green"></div>',
  border_dots5_rounded:
    '<div id="table" style="width:90px;height:30px;border:5px dotted green;border-radius:12px;margin-left:.375px;margin-top:.625px"></div>',
  glyph_positive_origin:
    '<div id="table" style="display:inline-block;margin-left:.875px;padding:4px"><div id="text">Empty table</div></div>',
  glyph_negative_origin:
    '<div id="table" style="display:inline-block;margin-left:-.125px;padding:4px"><div id="text">Empty table</div></div>',
  glyph_sizes:
    '<div id="table" style="display:inline-block;padding:4px"><div id="text" style="font-size:12px">Small text</div></div>',
});
const actions = {
  glyph_sizes: [
    { kind: 'attribute', selector: '#text', name: 'style', value: 'font-size:14px' },
    { kind: 'attribute', selector: '#text', name: 'style', value: 'font-size:16px' },
    { kind: 'attribute', selector: '#text', name: 'style', value: 'font-size:24px' },
  ],
  percentage_height: [
    {
      kind: 'attribute',
      selector: '#inside',
      name: 'style',
      value: 'width:30px;height:120px;background:blue',
    },
    { kind: 'attribute', selector: '#table', name: 'style', value: 'height:auto' },
  ],
  cellheight: [
    {
      kind: 'attribute',
      selector: '#a',
      name: 'style',
      value: 'height:20px;padding:8px;border:2px solid red',
    },
    {
      kind: 'attribute',
      selector: '#a',
      name: 'style',
      value: 'height:0px;padding:8px;border:2px solid red',
    },
  ],
  auto: [
    { kind: 'html', selector: '#a', value: 'A changed column with much wider text' },
    {
      kind: 'html',
      selector: '#body',
      value: '<tr id="row"><td id="a">Replacement</td><td id="b">rows</td></tr>',
    },
    { kind: 'attribute', selector: '#table', name: 'style', value: 'width:180px' },
    { kind: 'attribute', selector: '#table', name: 'style', value: 'width:500px' },
  ],
  spans: [
    { kind: 'attribute', selector: '#a', name: 'rowspan', value: '1' },
    { kind: 'attribute', selector: '#c', name: 'colspan', value: '1' },
  ],
  caption: [
    { kind: 'attribute', selector: '#caption', name: 'style', value: 'caption-side:bottom' },
  ],
  align: [
    { kind: 'attribute', selector: '#a', name: 'style', value: 'vertical-align:bottom' },
    { kind: 'attribute', selector: '#a', name: 'style', value: 'vertical-align:top' },
    { kind: 'attribute', selector: '#a', name: 'style', value: 'vertical-align:middle' },
  ],
};
await runRenderingCases(
  cases,
  actions,
  'tables',
  'table{border-spacing:2px}td,th{padding:4px}th{font-weight:normal}caption{padding:6px}',
);
