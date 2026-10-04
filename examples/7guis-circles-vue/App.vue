<script setup lang="ts">
import { computed, ref } from 'vue';
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
const history = ref<Circle[][]>([[]]);
const at = ref(0);
// The circles shown (a diameter being adjusted is not yet in the history).
const circles = ref<Circle[]>([]);
const next = ref(1);
// The circle under the pointer (nearest to it), filled grey.
const selected = ref(-1);
// The circle whose context menu is open, and where it opened.
const menuFor = ref(-1);
const menuAt = ref<Point>({ x: 0, y: 0 });
// The circle whose diameter the dialog adjusts, and its diameter before.
const adjusting = ref(-1);
const before = ref(0);
const shown = computed(() => (adjusting.value !== -1 ? adjusting.value : selected.value));

/** The pointer's position relative to the padding box of the canvas (the listening element). */
function point(e: MouseEvent): Point {
  const canvas = e.currentTarget;
  if (canvas === null) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left - canvas.clientLeft, y: e.clientY - r.top - canvas.clientTop };
}

function record(list: Circle[]) {
  history.value = [...history.value.slice(0, at.value + 1), list];
  at.value = at.value + 1;
  circles.value = list;
}

function add(e: MouseEvent) {
  if (adjusting.value !== -1) return;
  if (menuFor.value !== -1) {
    menuFor.value = -1;
    return;
  }
  const p = point(e);
  // Only a click on an empty area adds a circle.
  if (nearest(circles.value, p) !== -1) return;
  record([...circles.value, { id: next.value, x: p.x, y: p.y, d: DIAMETER }]);
  selected.value = next.value;
  next.value = next.value + 1;
}

function hover(e: MouseEvent) {
  if (adjusting.value === -1 && menuFor.value === -1) selected.value = nearest(circles.value, point(e));
}

function leave() {
  if (adjusting.value === -1 && menuFor.value === -1) selected.value = -1;
}

function context(e: MouseEvent) {
  e.preventDefault();
  if (adjusting.value !== -1) return;
  const p = point(e);
  menuFor.value = nearest(circles.value, p);
  menuAt.value = menuPosition(p);
}

function open() {
  adjusting.value = menuFor.value;
  before.value = diameter(circles.value, menuFor.value);
  menuFor.value = -1;
}

function change(delta: number) {
  circles.value = resize(circles.value, adjusting.value, delta);
}

function done() {
  if (diameter(circles.value, adjusting.value) !== before.value) record(circles.value);
  else circles.value = history.value[at.value];
  adjusting.value = -1;
}

function undo() {
  menuFor.value = -1;
  at.value = at.value - 1;
  circles.value = history.value[at.value];
}

function redo() {
  menuFor.value = -1;
  at.value = at.value + 1;
  circles.value = history.value[at.value];
}
</script>

<template>
  <main>
    <h1>Circle Drawer</h1>
    <div class="bar">
      <button id="undo" :disabled="at === 0 || adjusting !== -1" @click="undo">Undo</button>
      <button id="redo" :disabled="at === history.length - 1 || adjusting !== -1" @click="redo">Redo</button>
    </div>
    <div class="stage">
      <div id="canvas" class="canvas" @click="add" @mousemove="hover" @mouseleave="leave" @contextmenu="context">
        <div
          v-for="c in circles"
          :key="c.id"
          :id="`circle-${c.id}`"
          class="circle"
          :style="{
            left: `${c.x - c.d / 2}px`,
            top: `${c.y - c.d / 2}px`,
            width: `${c.d}px`,
            height: `${c.d}px`,
            backgroundColor: c.id === shown ? '#c4c9c0' : 'transparent',
          }"
        ></div>
      </div>
      <div v-if="menuFor !== -1" id="menu" class="menu" :style="{ left: `${menuAt.x}px`, top: `${menuAt.y}px` }">
        <button id="adjust" @click="open">Adjust diameter…</button>
      </div>
    </div>
    <div v-if="adjusting !== -1" id="dialog" class="dialog">
      <p id="adjusting">Adjust the diameter of the circle at {{ centre(circles, adjusting) }}</p>
      <div class="bar">
        <button id="smaller" @click="change(-STEP)">−</button>
        <span id="diameter">{{ diameter(circles, adjusting) }}</span>
        <button id="larger" @click="change(STEP)">+</button>
        <button id="done" @click="done">Done</button>
      </div>
    </div>
  </main>
</template>
