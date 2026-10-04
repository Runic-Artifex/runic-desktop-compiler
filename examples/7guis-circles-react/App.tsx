import React, { useState } from 'react';
import {
  DIAMETER,
  STEP,
  centre,
  diameter,
  menuPosition,
  nearest,
  resize,
  type Circle,
  type Point,
} from './circles.ts';

/** The pointer's position relative to the padding box of the canvas (the listening element). */
function point(e: React.MouseEvent<HTMLDivElement>): Point {
  // React's currentTarget is null outside the dispatch.
  const canvas = e.currentTarget;
  if (canvas === null) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left - canvas.clientLeft, y: e.clientY - r.top - canvas.clientTop };
}

const ORIGIN: Point = { x: 0, y: 0 };

export function App() {
  // The undo history: every state of the canvas, `at` the shown one.
  const [history, setHistory] = useState<Circle[][]>([[]]);
  const [at, setAt] = useState(0);
  // The circles shown (a diameter being adjusted is not yet in the history).
  const [circles, setCircles] = useState<Circle[]>([]);
  const [next, setNext] = useState(1);
  // The circle under the pointer (nearest to it), filled grey.
  const [selected, setSelected] = useState(-1);
  // The circle whose context menu is open, and where it opened.
  const [menuFor, setMenuFor] = useState(-1);
  const [menuAt, setMenuAt] = useState(ORIGIN);
  // The circle whose diameter the dialog adjusts, and its diameter before.
  const [adjusting, setAdjusting] = useState(-1);
  const [before, setBefore] = useState(0);
  const shown = adjusting !== -1 ? adjusting : selected;

  function record(list: Circle[]) {
    setHistory([...history.slice(0, at + 1), list]);
    setAt(at + 1);
    setCircles(list);
  }

  function add(e: React.MouseEvent<HTMLDivElement>) {
    if (adjusting !== -1) return;
    if (menuFor !== -1) {
      setMenuFor(-1);
      return;
    }
    const p = point(e);
    // Only a click on an empty area adds a circle.
    if (nearest(circles, p) !== -1) return;
    record([...circles, { id: next, x: p.x, y: p.y, d: DIAMETER }]);
    setSelected(next);
    setNext(next + 1);
  }

  function context(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    if (adjusting !== -1) return;
    const p = point(e);
    setMenuFor(nearest(circles, p));
    setMenuAt(menuPosition(p));
  }

  function open() {
    setAdjusting(menuFor);
    setBefore(diameter(circles, menuFor));
    setMenuFor(-1);
  }

  function done() {
    if (diameter(circles, adjusting) !== before) record(circles);
    else setCircles(history[at]);
    setAdjusting(-1);
  }

  function undo() {
    setMenuFor(-1);
    setAt(at - 1);
    setCircles(history[at - 1]);
  }

  function redo() {
    setMenuFor(-1);
    setAt(at + 1);
    setCircles(history[at + 1]);
  }

  return (
    <main>
      <h1>Circle Drawer</h1>
      <div className="bar">
        <button id="undo" disabled={at === 0 || adjusting !== -1} onClick={undo}>
          Undo
        </button>
        <button id="redo" disabled={at === history.length - 1 || adjusting !== -1} onClick={redo}>
          Redo
        </button>
      </div>
      <div className="stage">
        <div
          id="canvas"
          className="canvas"
          onClick={add}
          onMouseMove={e => {
            if (adjusting === -1 && menuFor === -1) setSelected(nearest(circles, point(e)));
          }}
          onMouseLeave={() => {
            if (adjusting === -1 && menuFor === -1) setSelected(-1);
          }}
          onContextMenu={context}
        >
          {circles.map(c => (
            <div
              key={c.id}
              id={`circle-${c.id}`}
              className="circle"
              style={{
                left: c.x - c.d / 2,
                top: c.y - c.d / 2,
                width: c.d,
                height: c.d,
                backgroundColor: c.id === shown ? '#c4c9c0' : 'transparent',
              }}
            ></div>
          ))}
        </div>
        {menuFor !== -1 && (
          <div id="menu" className="menu" style={{ left: menuAt.x, top: menuAt.y }}>
            <button id="adjust" onClick={open}>
              Adjust diameter…
            </button>
          </div>
        )}
      </div>
      {adjusting !== -1 && (
        <div id="dialog" className="dialog">
          <p id="adjusting">Adjust the diameter of the circle at {centre(circles, adjusting)}</p>
          <div className="bar">
            <button id="smaller" onClick={() => setCircles(resize(circles, adjusting, -STEP))}>
              −
            </button>
            <span id="diameter">{diameter(circles, adjusting)}</span>
            <button id="larger" onClick={() => setCircles(resize(circles, adjusting, STEP))}>
              +
            </button>
            <button id="done" onClick={done}>
              Done
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
