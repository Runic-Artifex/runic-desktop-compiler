export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export type Filter = 'all' | 'active' | 'completed';

export function visible(todos: Todo[], filter: Filter): Todo[] {
  if (filter === 'active') return todos.filter(t => !t.done);
  if (filter === 'completed') return todos.filter(t => t.done);
  return todos;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** localStorage key of the saved list. */
export const STORAGE_KEY = 'todos-runic';

const DEFAULTS: Todo[] = [
  { id: 1, title: 'Read the TodoMVC spec', done: true },
  { id: 2, title: 'Compile it to Rust', done: false },
];

/** The saved list, or the defaults on first start. */
export function load(): Todo[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return DEFAULTS.map(t => ({ id: t.id, title: t.title, done: t.done }));
  const saved: Todo[] = JSON.parse(raw);
  return saved;
}

export function nextId(todos: Todo[]): number {
  return todos.reduce((m, t) => Math.max(m, t.id), 0) + 1;
}
