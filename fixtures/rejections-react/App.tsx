import React, { useEffect, useState } from 'react';
import { chained, failLater, handledInMicrotask, rejectNow, timer } from './rejections.ts';

export function App() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    console.log('count ' + count);
  }, [count]);

  async function asyncFailure() {
    setCount(count + 1);
    await failLater();
  }

  function stateAndReject() {
    setCount(count + 1);
    Promise.reject(new Error('after a write'));
  }

  return (
    <main>
      <p id="count">{count}</p>
      <div className="row">
        <button id="reject" onClick={rejectNow}>
          Reject
        </button>
        <button id="handled" onClick={handledInMicrotask}>
          Handled
        </button>
        <button id="chained" onClick={chained}>
          Chained
        </button>
        <button id="async" onClick={asyncFailure}>
          Async
        </button>
        <button id="state" onClick={stateAndReject}>
          State
        </button>
        <button id="timer" onClick={timer}>
          Timer
        </button>
      </div>
    </main>
  );
}
