<script lang="ts">
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

  // The undo history: every state of the canvas, `at` the shown one.
  let history = $state.raw<Circle[][]>([[]]);
  let at = $state(0);
  // The circles shown (a diameter being adjusted is not yet in the history).
  let circles = $state.raw<Circle[]>([]);
  let next = $state(1);
  // The circle under the pointer (nearest to it), filled grey.
  let selected = $state(-1);
  // The circle whose context menu is open, and where it opened.
  let menuFor = $state(-1);
  let menuAt = $state.raw<Point>({ x: 0, y: 0 });
  // The circle whose diameter the dialog adjusts, and its diameter before.
  let adjusting = $state(-1);
  let before = $state(0);
  let canvas: HTMLDivElement;

  /** The pointer's position relative to the canvas's padding box. */
  function point(e: MouseEvent): Point {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left - canvas.clientLeft, y: e.clientY - r.top - canvas.clientTop };
  }

  function record(list: Circle[]) {
    history = [...history.slice(0, at + 1), list];
    at = at + 1;
    circles = list;
  }

  function add(e: MouseEvent) {
    if (adjusting !== -1) return;
    if (menuFor !== -1) {
      menuFor = -1;
      return;
    }
    const p = point(e);
    // Only a click on an empty area adds a circle.
    if (nearest(circles, p) !== -1) return;
    record([...circles, { id: next, x: p.x, y: p.y, d: DIAMETER }]);
    selected = next;
    next = next + 1;
  }

  function hover(e: MouseEvent) {
    if (adjusting === -1 && menuFor === -1) selected = nearest(circles, point(e));
  }

  function leave() {
    if (adjusting === -1 && menuFor === -1) selected = -1;
  }

  function context(e: MouseEvent) {
    e.preventDefault();
    if (adjusting !== -1) return;
    const p = point(e);
    menuFor = nearest(circles, p);
    menuAt = menuPosition(p);
  }

  function open() {
    adjusting = menuFor;
    before = diameter(circles, menuFor);
    menuFor = -1;
  }

  function done() {
    if (diameter(circles, adjusting) !== before) record(circles);
    else circles = history[at];
    adjusting = -1;
  }

  function undo() {
    menuFor = -1;
    at = at - 1;
    circles = history[at];
  }

  function redo() {
    menuFor = -1;
    at = at + 1;
    circles = history[at];
  }
</script>

<main>
  <h1>Circle Drawer</h1>
  <div class="bar">
    <button id="undo" disabled={at === 0 || adjusting !== -1} onclick={undo}>Undo</button>
    <button id="redo" disabled={at === history.length - 1 || adjusting !== -1} onclick={redo}>Redo</button>
  </div>
  <div class="stage">
    <div id="canvas" class="canvas" bind:this={canvas} onclick={add} onmousemove={hover} onmouseleave={leave} oncontextmenu={context}>
      {#each circles as c (c.id)}
        <div
          id={`circle-${c.id}`}
          class="circle"
          style:left="{c.x - c.d / 2}px"
          style:top="{c.y - c.d / 2}px"
          style:width="{c.d}px"
          style:height="{c.d}px"
          style:background-color={c.id === (adjusting !== -1 ? adjusting : selected) ? '#c4c9c0' : 'transparent'}
        ></div>
      {/each}
    </div>
    {#if menuFor !== -1}
      <div id="menu" class="menu" style:left="{menuAt.x}px" style:top="{menuAt.y}px">
        <button id="adjust" onclick={open}>Adjust diameter…</button>
      </div>
    {/if}
  </div>
  {#if adjusting !== -1}
    <div id="dialog" class="dialog">
      <p id="adjusting">Adjust the diameter of the circle at {centre(circles, adjusting)}</p>
      <div class="bar">
        <button id="smaller" onclick={() => (circles = resize(circles, adjusting, -STEP))}>−</button>
        <span id="diameter">{diameter(circles, adjusting)}</span>
        <button id="larger" onclick={() => (circles = resize(circles, adjusting, STEP))}>+</button>
        <button id="done" onclick={done}>Done</button>
      </div>
    </div>
  {/if}
</main>
