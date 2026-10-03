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
