// Minimal Vue declarations for type analysis of <script setup>.
declare module 'vue' {
  export interface Ref<T> {
    value: T;
  }
  export function ref<T>(value: T): Ref<T>;
  export function ref<T = undefined>(): Ref<T | undefined>;
  export function shallowRef<T>(value: T): Ref<T>;
  export function computed<T>(getter: () => T): Readonly<Ref<T>>;
  export function createApp(component: unknown): { mount(selector: string): void };
}
declare module '*.vue' {
  const component: unknown;
  export default component;
}
/** Template scope: refs are unwrapped. */
declare function __runic_unref<T>(value: T): T extends import('vue').Ref<infer U> ? U : T;

// <script setup> compiler macros (type-based declarations only).
declare function defineProps<T>(): T;
declare function withDefaults<T, D extends { [K in keyof T]?: unknown }>(
  props: T,
  defaults: D,
): Omit<T, keyof D> & { [K in keyof D & keyof T]-?: Exclude<T[K], undefined> };
type __RunicEmitFn<T> = T extends (...args: never[]) => unknown
  ? T
  : <K extends keyof T & string>(event: K, ...args: T[K] extends unknown[] ? T[K] : never) => void;
declare function defineEmits<T>(): __RunicEmitFn<T>;
declare function defineModel<T>(options: {
  required: true;
  default?: T | (() => T);
}): import('vue').Ref<T>;
declare function defineModel<T>(options: {
  default: T | (() => T);
  required?: boolean;
}): import('vue').Ref<T>;
declare function defineModel<T>(options?: { required?: false }): import('vue').Ref<T | undefined>;
declare function defineModel<T>(
  name: string,
  options: { required: true; default?: T | (() => T) },
): import('vue').Ref<T>;
declare function defineModel<T>(
  name: string,
  options: { default: T | (() => T); required?: boolean },
): import('vue').Ref<T>;
declare function defineModel<T>(
  name: string,
  options?: { required?: false },
): import('vue').Ref<T | undefined>;
/** `defineSlots<{ name(props: P): any }>()` (type-only; the result is not lowered). */
declare function defineSlots<T>(): T;

// Template typing of slots: a `<slot>` outlet returns its props from the
// synthetic template function (so untyped slots infer their props), and slot
// content destructures the props of the child's slot.
declare const __runic_never: boolean;
declare function __runic_slot<S, K extends string>(): K extends keyof S
  ? NonNullable<S[K]> extends (props: infer P, ...rest: never[]) => unknown
    ? P
    : Record<string, never>
  : never;
