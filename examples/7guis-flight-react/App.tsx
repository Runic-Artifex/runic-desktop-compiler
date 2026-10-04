import React, { useState } from 'react';
import { parseDate } from './dates.ts';

export function App() {
  const [kind, setKind] = useState('one-way');
  const [start, setStart] = useState('27.03.2014');
  const [back, setBack] = useState('27.03.2014');
  const [message, setMessage] = useState('');
  const isReturn = kind === 'return';
  const startTime = parseDate(start);
  const backTime = parseDate(back);
  const bookable =
    startTime !== null && (!isReturn || (backTime !== null && backTime >= startTime));

  function book() {
    setMessage(
      isReturn
        ? `You have booked a return flight on ${start}, returning on ${back}.`
        : `You have booked a one-way flight on ${start}.`,
    );
  }

  return (
    <main>
      <h1>Flight Booker</h1>
      <select id="kind" aria-label="Flight" value={kind} onChange={e => setKind(e.target.value)}>
        <option value="one-way">one-way flight</option>
        <option value="return">return flight</option>
      </select>
      <input
        id="start"
        type="text"
        aria-label="Start date"
        className={startTime === null ? 'invalid' : undefined}
        value={start}
        onChange={e => setStart(e.target.value)}
      />
      <input
        id="return"
        type="text"
        aria-label="Return date"
        className={isReturn && backTime === null ? 'invalid' : undefined}
        disabled={!isReturn}
        value={back}
        onChange={e => setBack(e.target.value)}
      />
      <button id="book" disabled={!bookable} onClick={book}>
        Book
      </button>
      <p id="message">{message}</p>
    </main>
  );
}
