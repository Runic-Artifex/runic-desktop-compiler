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
