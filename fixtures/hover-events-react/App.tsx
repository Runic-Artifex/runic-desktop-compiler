import { useState, type MouseEvent } from 'react';

const names = ['a', 'b', 'c'];

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [overs, setOvers] = useState(0);
  const [targets, setTargets] = useState<string[]>([]);
  function record(event: MouseEvent<HTMLElement>) {
    const entry = `${event.type}:${event.target.id}:${event.currentTarget!.id}:${event.relatedTarget === null ? '-' : event.relatedTarget.id}:${event.button}:${event.buttons}`;
    setTargets(entries => [...entries, entry].slice(-14));
  }
  function add(entry: string) {
    setLog(l => [...l, entry].slice(-14));
  }
  return (
    <main>
      <h1>Hover events</h1>
      <ul
        id="list"
        onPointerOver={record}
        onPointerOut={record}
        onMouseOver={event => {
          setOvers(o => o + 1);
          record(event);
        }}
        onMouseOut={event => {
          add('list:out');
          record(event);
        }}
      >
        {names.map(name => (
          <li
            key={name}
            id={`item-${name}`}
            onPointerOver={event => {
              add(`${name}:pover`);
              record(event);
            }}
            onPointerOut={event => {
              add(`${name}:pout`);
              record(event);
            }}
            onMouseOver={event => {
              add(`${name}:over`);
              record(event);
            }}
            onMouseOut={event => {
              add(`${name}:out`);
              record(event);
            }}
          >
            <span id={`label-${name}`}>{name}</span>
          </li>
        ))}
      </ul>
      <p
        id="title"
        onPointerOver={record}
        onPointerOut={record}
        onMouseOver={record}
        onMouseOut={record}
      >
        Outside the list
      </p>
      <p
        id="direct"
        onPointerOver={record}
        onPointerOut={record}
        onMouseOver={record}
        onMouseOut={record}
      >
        Direct {names[0]} target text
      </p>
      <p id="overs">{overs}</p>
      <p id="log">{log.join(' ')}</p>
      <p id="boundary-log">{targets.join(' ')}</p>
    </main>
  );
}
