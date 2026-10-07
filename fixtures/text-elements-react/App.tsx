import { useState } from 'react';

export function App() {
  const [marked, setMarked] = useState(true);
  const [edited, setEdited] = useState(false);
  const [count, setCount] = useState(2);
  return (
    <main>
      <h1>Text elements</h1>
      <p id="formula">
        E = mc<sup>{count}</sup> and H<sub>{count}</sub>O
      </p>
      <p id="keys">
        Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to search; the program prints <samp>ok</samp>.
      </p>
      <p id="mark">A {marked ? <mark>highlighted</mark> : 'plain'} word.</p>
      <p id="time">
        Released <time dateTime="2026-10-07">7 October</time>, code <data value="42">forty-two</data>.
      </p>
      <p id="abbr">
        <abbr title="Cascading Style Sheets">CSS</abbr> and <dfn>layout</dfn> with <var>x</var>.
      </p>
      <p id="edit">
        Price:{' '}
        {edited ? (
          <>
            <del>10</del> <ins>8</ins>
          </>
        ) : (
          '10'
        )}{' '}
        <s>old</s> <u>note</u>
      </p>
      <blockquote id="quote">
        <p>Simplicity is prerequisite for reliability.</p>
        <cite>Edsger Dijkstra</cite>
      </blockquote>
      <address id="address">Runic, Example Street 1</address>
      <div className="controls">
        <button id="mark-toggle" onClick={() => setMarked(!marked)}>
          Mark
        </button>
        <button id="edit-toggle" onClick={() => setEdited(!edited)}>
          Edit
        </button>
        <button id="more" onClick={() => setCount(count + 1)}>
          More
        </button>
      </div>
    </main>
  );
}
