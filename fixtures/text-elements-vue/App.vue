<script setup lang="ts">
import { ref } from 'vue';
const marked = ref(true);
const edited = ref(false);
const count = ref(2);
</script>

<template>
  <main>
    <h1>Text elements</h1>
    <p id="formula">E = mc<sup>{{ count }}</sup> and H<sub>{{ count }}</sub>O</p>
    <p id="keys">Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to search; the program prints <samp>ok</samp>.</p>
    <p id="mark">A <mark v-if="marked">highlighted</mark><span v-else>plain</span> word.</p>
    <p id="time">Released <time datetime="2026-10-07">7 October</time>, code <data value="42">forty-two</data>.</p>
    <p id="abbr"><abbr title="Cascading Style Sheets">CSS</abbr> and <dfn>layout</dfn> with <var>x</var>.</p>
    <p id="edit">Price: <span v-if="edited"><del>10</del> <ins>8</ins></span><span v-else>10</span> <s>old</s> <u>note</u></p>
    <blockquote id="quote">
      <p>Simplicity is prerequisite for reliability.</p>
      <cite>Edsger Dijkstra</cite>
    </blockquote>
    <address id="address">Runic, Example Street 1</address>
    <div class="controls">
      <button id="mark-toggle" @click="marked = !marked">Mark</button>
      <button id="edit-toggle" @click="edited = !edited">Edit</button>
      <button id="more" @click="count++">More</button>
    </div>
  </main>
</template>
