import React, { useState } from 'react';
import { TodoItem } from './TodoItem.tsx';
import { visible, plural, type Todo, type Filter } from './todos.ts';

export function App() {
  const [todos, setTodos] = useState<Todo[]>([
    { id: 1, title: 'Read the TodoMVC spec', done: true },
    { id: 2, title: 'Compile it to Rust', done: false },
  ]);
  const [next, setNext] = useState(3);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const shown = visible(todos, filter);
  const left = todos.filter(t => !t.done).length;
  const completed = todos.length - left;

  function add() {
    const title = draft.trim();
    if (title === '') return;
    setTodos([...todos, { id: next, title, done: false }]);
    setNext(next + 1);
    setDraft('');
  }
  function toggle(id: number, done: boolean) {
    setTodos(ts => ts.map((t): Todo => (t.id === id ? { ...t, done } : t)));
  }
  function remove(id: number) {
    setTodos(todos.filter(t => t.id !== id));
  }
  function toggleAll(done: boolean) {
    setTodos(todos.map((t): Todo => ({ ...t, done })));
  }
  function clearCompleted() {
    setTodos(todos.filter(t => !t.done));
  }

  return (
    <main>
      <h1>todos</h1>
      <div className="new">
        {todos.length > 0 && (
          <input
            id="toggle-all"
            type="checkbox"
            aria-label="Mark all as complete"
            checked={left === 0}
            onChange={e => toggleAll(e.target.checked)}
          />
        )}
        <input
          id="new-todo"
          type="text"
          aria-label="New todo"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') add();
            else if (e.key === 'Escape') setDraft('');
          }}
        />
      </div>
      <ul>
        {shown.map(todo => (
          <TodoItem key={todo.id} todo={todo} onToggle={toggle} onRemove={remove} />
        ))}
      </ul>
      {todos.length > 0 && (
        <footer>
          <span id="count" className="count">
            {plural(left, 'item')} left
          </span>
          <div className="filters">
            <button
              id="filter-all"
              className={filter === 'all' ? 'selected' : undefined}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              id="filter-active"
              className={filter === 'active' ? 'selected' : undefined}
              onClick={() => setFilter('active')}
            >
              Active
            </button>
            <button
              id="filter-completed"
              className={filter === 'completed' ? 'selected' : undefined}
              onClick={() => setFilter('completed')}
            >
              Completed
            </button>
          </div>
          {completed > 0 && (
            <button id="clear" onClick={clearCompleted}>
              Clear completed
            </button>
          )}
        </footer>
      )}
    </main>
  );
}
