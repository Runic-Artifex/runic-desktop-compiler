// Untyped JavaScript: objects of varying shapes, runtime keys and values of
// several types, which compile only with dynamic values.
export function makeItems(n) {
  const items = [];
  for (let i = 1; i <= n; i++)
    items.push(i % 2 ? { kind: 'odd', n: i } : { kind: 'even', n: i, half: i / 2 });
  return items;
}

export function keyed(a, b) {
  return { [a]: 1, [b]: 2 };
}

export function describe(x) {
  return x.kind + ':' + x.n + (x.half ? '/' + x.half : '');
}

export function tally(items) {
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1;
  return counts;
}

export function pick(flag) {
  return flag ? 1 : 'one';
}

export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.half ?? item.n;
  return sum;
}

export function apply(f, x) {
  return f(x);
}

const ops = { double: n => n * 2, square: n => n * n, label: n => 'n=' + n };

export function run(name, x) {
  return ops[name](x);
}

export function names(x) {
  return [x, x + 1].map(n => 'v' + n).join(',');
}
