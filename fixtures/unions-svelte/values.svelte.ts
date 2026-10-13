// Values of several members (M6 unions): a `string | number` holds either,
// and every operation is the member's, as bits-ui's announcer and
// shadcn-svelte's clipboard hook use it.

/** bits-ui's `announce(value)`: the member decides the text. */
export function describe(value: string | null | number): string {
  if (typeof value === 'number') {
    value = value.toString();
  } else if (value === null) {
    value = 'Empty';
  } else {
    value = value.trim();
  }
  return `[${value}]`;
}

/** shadcn-svelte's `copy(text)`: the text of either member. */
export function copied(text: string | number): string {
  return text.toString();
}

export class Store {
  value = $state<string | number>(0);
  history = $state<string[]>([]);

  set(v: string | number) {
    this.history.push(copied(v));
    this.value = v;
  }

  bump() {
    const v = this.value;
    this.value = typeof v === 'number' ? v + 1 : `${v}!`;
  }
}
