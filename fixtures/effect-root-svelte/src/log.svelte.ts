// Effect roots (Svelte's $effect.root, M6: bits-ui's SharedState and its
// keyboard tracking): effects that belong to a root, not to an instance,
// until the root is destroyed. The log is written untracked, so the
// effects depend on the value only.
import { untrack } from 'svelte';

export const log: string[] = $state([]);
let value = $state(0);

function note(line: string) {
  untrack(() => {
    log.push(line);
  });
}

export function current(): number {
  return value;
}

export function bump() {
  value++;
}

export function start(name: string): () => void {
  return $effect.root(() => {
    note(name + ' created');
    $effect(() => {
      note(name + ' run ' + value);
      return () => {
        // (Not reading the state: cleanups reading reactive fields see their
        // current values, not the previous ones as in Svelte; docs/CONTRACT.md.)
        note(name + ' cleanup');
      };
    });
    return () => {
      note(name + ' destroyed');
    };
  });
}
