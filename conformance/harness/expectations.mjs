// Case-authored semantic expectations supplement the independent comparison:
// identical browser/native mistakes must not satisfy a driving specification.
export function checkExpectedText(steps, expectations = []) {
  if (!Array.isArray(expectations)) throw new Error('expectedText must be an array');
  const seen = new Set();
  const failures = [];
  for (const expected of expectations) {
    if (!expected || !Number.isSafeInteger(expected.step) || expected.step < 0 ||
        typeof expected.id !== 'string' || !expected.id || typeof expected.text !== 'string')
      throw new Error('expectedText entries require nonnegative step, nonempty id and string text');
    const key = JSON.stringify([expected.step, expected.id]);
    if (seen.has(key)) throw new Error('Duplicate expectedText entry: ' + key);
    seen.add(key);
    const snapshot = steps[expected.step];
    const matches = [];
    const find = node => {
      if (!node) return;
      if (node.attributes?.id === expected.id) matches.push(node);
      for (const child of node.children ?? []) find(child);
    };
    find(snapshot?.dom);
    for (const portal of snapshot?.portals ?? []) find(portal);
    const text = node => 'text' in node ? node.text : (node.children ?? []).map(text).join('');
    const actual = matches.length === 1 ? text(matches[0]) : null;
    if (!snapshot || matches.length !== 1 || actual !== expected.text)
      failures.push({ ...expected, actual, reason: !snapshot ? 'missing step' :
        matches.length !== 1 ? `expected exactly one element; found ${matches.length}` : 'text differs' });
  }
  return { checked: expectations.length, passed: failures.length === 0, failures };
}
