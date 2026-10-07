import { runRenderingCases } from './harness/rendering.mjs';
import { cssAnimationCases } from './css-animations-cases.mjs';
await runRenderingCases(
  Object.fromEntries(Object.entries(cssAnimationCases).map(([name, c]) => [name, { ...c, suite: 'css-behavior' }])),
  {},
  'css-animations',
);
