// Parameters with defaults (shared language): a caller may leave such a
// parameter out or pass undefined, which takes the default, evaluated when
// the call runs, left to right, reading the parameters before it; null is
// kept. Direct calls, a function value of a type taking fewer arguments,
// a callback, methods, constructors and super(…).

export function label(x: number, unit: string = 'item', plural = unit + 's'): string {
  return x + ' ' + (x === 1 ? unit : plural);
}

export function clamp(x: number, lo = 0, hi = lo + 10): number {
  return Math.min(Math.max(x, lo), hi);
}

function greet(name: string | null = 'guest'): string {
  return 'hi ' + String(name);
}

class Tally {
  total: number;
  constructor(start = 100) {
    this.total = start;
  }
  add(x: number, times = 1): number {
    this.total += x * times;
    return this.total;
  }
}

class Bonus extends Tally {
  constructor(start = 5) {
    super(start * 2);
  }
}

const short: (x: number) => string = label;

export function run(k: number): string[] {
  const calls: string[] = [];
  const note = (s: string): number => {
    calls.push(s);
    return s.length;
  };
  const lazy = (n: number = note('d' + k)): number => n;
  return [
    label(k),
    label(k, 'box'),
    label(k, 'mouse', 'mice'),
    label(k, undefined, 'things'),
    String(clamp(k * 7)),
    String(clamp(k * 7, 3)),
    String(clamp(-k, undefined, 2)),
    greet(),
    greet(null),
    greet(k % 2 ? undefined : 'ada'),
    lazy() + ' ' + lazy(k) + ' ' + lazy() + ' ' + calls.join(','),
    String(new Tally().add(k)),
    String(new Tally(k).add(2, 3)),
    String(new Bonus().total),
    String(new Bonus(k).add(1, undefined)),
    short(k),
    [10, 20].map((v, i = 5) => v + i * k).join('+'),
  ];
}
