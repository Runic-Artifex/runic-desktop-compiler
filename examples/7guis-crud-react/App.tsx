import React, { useState } from 'react';
import { Entry } from './Entry.tsx';
import { matching, type Person } from './people.ts';

export function App() {
  const [people, setPeople] = useState<Person[]>([
    { id: 1, name: 'Hans', surname: 'Emil' },
    { id: 2, name: 'Max', surname: 'Mustermann' },
    { id: 3, name: 'Roman', surname: 'Tisch' },
  ]);
  const [next, setNext] = useState(4);
  const [prefix, setPrefix] = useState('');
  const [name, setName] = useState('');
  const [surname, setSurname] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const shown = matching(people, prefix);
  const valid = name.trim() !== '' && surname.trim() !== '';

  function select(id: number) {
    setSelected(id);
    const p = people.find(x => x.id === id);
    if (p) {
      setName(p.name);
      setSurname(p.surname);
    }
  }
  function create() {
    setPeople([...people, { id: next, name: name.trim(), surname: surname.trim() }]);
    setSelected(next);
    setNext(next + 1);
  }
  function update() {
    setPeople(
      people.map((p): Person =>
        p.id === selected ? { ...p, name: name.trim(), surname: surname.trim() } : p,
      ),
    );
  }
  function remove() {
    setPeople(people.filter(x => x.id !== selected));
    setSelected(null);
    setName('');
    setSurname('');
  }

  return (
    <main>
      <h1>CRUD</h1>
      <p className="field filter">
        Filter prefix{' '}
        <input
          id="prefix"
          type="text"
          aria-label="Filter prefix"
          value={prefix}
          onChange={e => setPrefix(e.target.value)}
        />
      </p>
      <div className="grid">
        <ul className="list">
          {shown.map(person => (
            <Entry
              key={person.id}
              person={person}
              selected={person.id === selected}
              onSelect={select}
            />
          ))}
        </ul>
        <div className="fields">
          <p className="field">
            Name{' '}
            <input
              id="name"
              type="text"
              aria-label="Name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </p>
          <p className="field">
            Surname{' '}
            <input
              id="surname"
              type="text"
              aria-label="Surname"
              value={surname}
              onChange={e => setSurname(e.target.value)}
            />
          </p>
        </div>
      </div>
      <div className="row">
        <button id="create" disabled={!valid} onClick={create}>
          Create
        </button>
        <button id="update" disabled={selected === null || !valid} onClick={update}>
          Update
        </button>
        <button id="delete" disabled={selected === null} onClick={remove}>
          Delete
        </button>
      </div>
    </main>
  );
}
