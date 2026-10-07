// Ordinary border-painter controls, kept outside table layout conformance.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {
  border_dotted_rounded:
    '<div id="table" style="width:90px;height:30px;border:5px dotted green;border-radius:12px;margin-left:.375px;margin-top:.625px"></div>',
  border_dotted_rounded_thin:
    '<div id="table" style="width:96px;height:34px;border:3px dotted #286;border-radius:14px"></div>',
  border_dotted_rounded_wide:
    '<div id="table" style="width:92px;height:36px;border:7px dotted #286;border-radius:18px"></div>',
  border_dotted_rounded_elliptical:
    '<div id="table" style="width:112px;height:40px;border:5px dotted #286;border-radius:22px / 12px"></div>',
  border_dotted_rounded_asymmetric:
    '<div id="table" style="width:106px;height:44px;border:5px dotted #286;border-radius:17px 8px 14px 5px"></div>',
  border_dotted_rounded_fractional:
    '<div id="table" style="width:96px;height:34px;border:5px dotted #286;border-radius:15px;margin-left:.375px;margin-top:.625px"></div>',
  border_dotted_rounded_mixed_widths:
    '<div id="table" style="width:104px;height:42px;border-style:dotted;border-color:#286;border-width:3px 5px 7px 4px;border-radius:16px"></div>',
};

await runRenderingCases(cases, {}, 'borders');
