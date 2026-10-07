<script lang="ts">
  let marked = $state(true);
  let edited = $state(false);
  let count = $state(2);
</script>

<main>
  <h1>Text elements</h1>
  <p id="formula">E = mc<sup>{count}</sup> and H<sub>{count}</sub>O</p>
  <p id="keys">Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to search; the program prints <samp>ok</samp>.</p>
  <p id="mark">A {#if marked}<mark>highlighted</mark>{:else}plain{/if} word.</p>
  <p id="time">Released <time datetime="2026-10-07">7 October</time>, code <data value="42">forty-two</data>.</p>
  <p id="abbr"><abbr title="Cascading Style Sheets">CSS</abbr> and <dfn>layout</dfn> with <var>x</var>.</p>
  <p id="edit">Price: {#if edited}<del>10</del> <ins>8</ins>{:else}10{/if} <s>old</s> <u>note</u></p>
  <blockquote id="quote">
    <p>Simplicity is prerequisite for reliability.</p>
    <cite>Edsger Dijkstra</cite>
  </blockquote>
  <address id="address">Runic, Example Street 1</address>
  <div class="controls">
    <button id="mark-toggle" onclick={() => (marked = !marked)}>Mark</button>
    <button id="edit-toggle" onclick={() => (edited = !edited)}>Edit</button>
    <button id="more" onclick={() => count++}>More</button>
  </div>
</main>
