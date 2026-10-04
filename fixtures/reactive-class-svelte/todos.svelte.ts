// A class-based store with reactive fields (M6 stage B, case `reactive-classes`).

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export type Mode = 'all' | 'open' | 'done';

/** A filter: a class instance, which Svelte's $state never proxies. */
export class Filter {
  mode = $state<Mode>('all');

  matches(todo: Todo): boolean {
    return this.mode === 'all' || (this.mode === 'done') === todo.done;
  }
}

export class TodoList {
  /** Deep state: stored plain objects and arrays become proxies. */
  items = $state<Todo[]>([]);
  /** A private reactive field behind a getter. */
  #nextId = $state(1);
  /** Raw state: only replacing the array notifies. */
  history = $state.raw<string[]>([]);
  /** A class instance in a $state field is stored as it is. */
  filter = $state(new Filter());
  /** Assigned in the constructor. */
  title: string;
  remaining = $derived(this.items.filter(t => !t.done).length);
  done = $derived.by(() => {
    let n = 0;
    for (const t of this.items) if (t.done) n++;
    return n;
  });
  visible = $derived(this.items.filter(t => this.filter.matches(t)));
  summary = $derived(`${this.title}: ${this.remaining} of ${this.items.length} open`);

  constructor(title: string) {
    this.title = $state(title);
  }

  get nextId(): number {
    return this.#nextId;
  }

  get last(): string {
    return this.history.at(-1) ?? 'nothing yet';
  }

  add(text: string): void {
    this.items.push({ id: this.#nextId, text, done: false });
    this.#nextId++;
    this.history = [...this.history, `added ${text}`];
  }

  toggle(todo: Todo): void {
    todo.done = !todo.done;
  }

  clearDone(): void {
    const before = this.items.length;
    this.items = this.items.filter(t => !t.done);
    this.history = [...this.history, `cleared ${before - this.items.length}`];
  }

  rename(): void {
    this.title = `${this.title}!`;
  }

  /** A stored plain object becomes a proxy; a stored class instance does not. */
  adopt(): void {
    const todo: Todo = { id: this.#nextId, text: 'adopted', done: true };
    this.items.push(todo);
    this.#nextId++;
    const filter = new Filter();
    filter.mode = this.filter.mode;
    this.filter = filter;
    console.log(`proxied: ${!this.items.includes(todo)}, filter kept: ${this.filter === filter}`);
  }
}

/** A module-level instance (a program global) whose fields are reactive. */
export class Tally {
  count = $state(0);
  label = $derived(this.count === 1 ? '1 switch' : `${this.count} switches`);
}

export const tally = new Tally();
