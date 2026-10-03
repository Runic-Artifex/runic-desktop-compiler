import React from 'react';
import type { Todo } from './todos.ts';

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: number, done: boolean) => void;
  onRemove: (id: number) => void;
}

export function TodoItem({ todo, onToggle, onRemove }: TodoItemProps) {
  return (
    <li id={`todo-${todo.id}`} className={todo.done ? 'completed' : undefined}>
      <input
        id={`toggle-${todo.id}`}
        type="checkbox"
        aria-label="Done"
        checked={todo.done}
        onChange={e => onToggle(todo.id, e.target.checked)}
      />
      <span id={`title-${todo.id}`}>{todo.title}</span>
      <button id={`destroy-${todo.id}`} className="destroy" onClick={() => onRemove(todo.id)}>
        Delete
      </button>
    </li>
  );
}
