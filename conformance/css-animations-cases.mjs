// Reduced CSS-animation timelines sampled by the shared virtual-time driver.
//
// Each entry names the initial HTML plus the exact clock-time mutations that a
// time-aware oracle performs. The at field is milliseconds from document
// creation, and every state is observed after resolving style at that time.
export const cssAnimationCases = {
  fill_forwards_survives_restyle: {
    html:
      '<style>@keyframes move{from{width:20px}to{width:80px}}</style>' +
      '<div id="table"><div id="target" style="height:20px;background:#dce8ff;animation:move 100ms linear forwards"></div></div>',
    viewports: [
      [420, 180],
      [800, 180],
    ],
    timeline: [
      { at: 125, kind: 'observe' },
      { at: 125, kind: 'attribute', selector: '#target', name: 'data-restyled', value: 'yes' },
      { at: 125, kind: 'observe' },
    ],
  },
  fill_both_before_and_after: {
    html:
      '<style>@keyframes shift{from{margin-left:36px}to{margin-left:92px}}</style>' +
      '<div id="table"><div id="target" style="width:20px;height:20px;background:#dce8ff;animation:shift 100ms linear 50ms both"></div></div>',
    viewports: [
      [420, 180],
      [800, 180],
    ],
    timeline: [
      { at: 0, kind: 'observe' },
      { at: 75, kind: 'observe' },
      { at: 175, kind: 'observe' },
      { at: 175, kind: 'attribute', selector: '#target', name: 'data-restyled', value: 'yes' },
      { at: 175, kind: 'observe' },
    ],
  },
  cancellation_name_and_display_reset: {
    html:
      '<style>@keyframes move{from{width:20px}to{width:80px}}@keyframes other{from{width:20px}to{width:120px}}</style>' +
      '<div id="table"><div id="target" style="height:20px;background:#dce8ff;animation:move 100ms linear forwards"></div></div>',
    viewports: [
      [420, 180],
      [800, 180],
    ],
    timeline: [
      {
        at: 125,
        kind: 'style',
        selector: '#target',
        value: 'height:20px;background:#dce8ff;animation-name:none',
      },
      { at: 125, kind: 'observe' },
      {
        at: 150,
        kind: 'style',
        selector: '#target',
        value: 'height:20px;background:#dce8ff;animation:other 100ms linear forwards',
      },
      { at: 275, kind: 'observe' },
      {
        at: 275,
        kind: 'style',
        selector: '#target',
        value: 'display:none;height:20px;background:#dce8ff;animation:other 100ms linear forwards',
      },
      { at: 275, kind: 'observe' },
    ],
  },
  late_frame_alternate_iterations: {
    html:
      '<style>@keyframes move{from{margin-left:0}to{margin-left:100px}}</style>' +
      '<div id="table"><div id="target" style="width:20px;height:20px;background:#dce8ff;animation:move 100ms linear 4 alternate both"></div></div>',
    viewports: [
      [420, 180],
      [800, 180],
    ],
    timeline: [
      { at: 325, kind: 'observe' },
      { at: 425, kind: 'observe' },
    ],
  },
};
