// Contexts keyed by module-level symbols, as shadcn-svelte's carousel keys
// its context (registry/ui/carousel/context.ts): a symbol is only a key of
// setContext, getContext and hasContext. TONE and OTHER have the same
// description and are still two keys; UNSET is never set.
import { getContext, hasContext, setContext } from 'svelte';

const TONE = Symbol('TONE');
const OTHER = Symbol('TONE');
const UNSET = Symbol();

export type Tone = {
  label: string;
  count: number;
  bump: () => void;
  reset: () => void;
};

export function setTone(tone: Tone): Tone {
  setContext(TONE, tone);
  return tone;
}

export function getTone(name = 'This component') {
  if (!hasContext(TONE)) {
    throw new Error(`${name} must be used within a <Provider> component`);
  }
  return getContext<ReturnType<typeof setTone>>(TONE);
}

export function hasTone(): boolean {
  return hasContext(TONE);
}

export function setOther(value: string) {
  setContext(OTHER, value);
}

export function getOther() {
  return getContext<string | undefined>(OTHER);
}

export function hasUnset(): boolean {
  return hasContext(UNSET);
}
