// Minimal Vue declarations for type analysis of <script setup>.
declare module 'vue' {
  export interface Ref<T> {
    value: T;
  }
  export function ref<T>(value: T): Ref<T>;
  export function ref<T = undefined>(): Ref<T | undefined>;
  export function shallowRef<T>(value: T): Ref<T>;
  export function computed<T>(getter: () => T): Readonly<Ref<T>>;
  /** A template ref (3.5): set by Vue to the element with `ref="key"` while it is mounted. */
  export function useTemplateRef<T = unknown>(key: string): Readonly<Ref<T | null>>;
  export function createApp(component: unknown): { mount(selector: string): void };

  // Watchers and lifecycle hooks (docs/design/M4-EFFECTS.md).
  export type OnCleanup = (cleanupFn: () => void) => void;
  export type WatchSource<T = unknown> = Ref<T> | Readonly<Ref<T>> | (() => T);
  export interface WatchOptions<Immediate = boolean> {
    immediate?: Immediate;
    deep?: boolean | number;
    once?: boolean;
    flush?: 'pre' | 'post' | 'sync';
    onTrack?: (event: unknown) => void;
    onTrigger?: (event: unknown) => void;
  }
  export interface WatchHandle {
    (): void;
    stop(): void;
    pause(): void;
    resume(): void;
  }
  type MapSources<T, Immediate> = {
    [K in keyof T]: T[K] extends WatchSource<infer V>
      ? Immediate extends true
        ? V | undefined
        : V
      : never;
  };
  export function watch<T, Immediate extends Readonly<boolean> = false>(
    source: WatchSource<T>,
    cb: (
      value: T,
      oldValue: Immediate extends true ? T | undefined : T,
      onCleanup: OnCleanup,
    ) => unknown,
    options?: WatchOptions<Immediate>,
  ): WatchHandle;
  export function watch<
    T extends Readonly<WatchSource<unknown>[]>,
    Immediate extends Readonly<boolean> = false,
  >(
    sources: readonly [...T] | T,
    cb: (
      value: MapSources<T, false>,
      oldValue: MapSources<T, Immediate>,
      onCleanup: OnCleanup,
    ) => unknown,
    options?: WatchOptions<Immediate>,
  ): WatchHandle;
  export function watchEffect(
    effect: (onCleanup: OnCleanup) => void,
    options?: { flush?: 'pre' | 'post' | 'sync' },
  ): WatchHandle;
  export function watchPostEffect(effect: (onCleanup: OnCleanup) => void): WatchHandle;
  export function watchSyncEffect(effect: (onCleanup: OnCleanup) => void): WatchHandle;
  export function onWatcherCleanup(cleanupFn: () => void): void;
  /** The pending flush's promise (fulfilled already when no flush is pending). */
  export function nextTick(): Promise<void>;
  export function nextTick<R>(fn: () => R): Promise<R>;
  export function onBeforeMount(hook: () => unknown): void;
  export function onMounted(hook: () => unknown): void;
  export function onBeforeUpdate(hook: () => unknown): void;
  export function onUpdated(hook: () => unknown): void;
  export function onBeforeUnmount(hook: () => unknown): void;
  export function onUnmounted(hook: () => unknown): void;
  export function nextTick(fn?: () => void): unknown;
}
declare module '*.vue' {
  const component: unknown;
  export default component;
}
/** Template listeners: `$event` and handler parameters have the event's interface. */
declare function __runic_on<E>(handler: (event: E) => void): void;
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
