<script lang="ts">
  // Imperative mounts (M6 overlays): content portalled to the body by
  // bits-ui's Portal (compiled from its published source; its target, a
  // union of an element and a selector, is the selector "body" by default),
  // with the app's contexts and state, in mount order, unmounted with its
  // portal or when disabled.
  import { Portal } from 'bits-ui';
  import Badge from './Badge.svelte';
  import { ThemeContext } from './theme.ts';

  ThemeContext.set('dark');

  let first = $state(false);
  let second = $state(false);
  let inline = $state(false);
  let count = $state(0);
</script>

<div id="app">
  <p id="status">count {count}, first {first}, second {second}, inline {inline}</p>
  <div class="controls">
    <button id="first" onclick={() => (first = !first)}>Toggle first</button>
    <button id="second" onclick={() => (second = !second)}>Toggle second</button>
    <button id="inline" onclick={() => (inline = !inline)}>Toggle inline</button>
  </div>
  {#if first}
    <Portal disabled={inline}>
      <div id="first-box" class="box">
        <Badge label="first" />
        <span id="first-count">{count}</span>
        <button id="inc" onclick={() => count++}>Increment</button>
      </div>
    </Portal>
  {/if}
  {#if second}
    <Portal>
      <div id="second-box" class="box">
        <Badge label="second" />
        <button id="dec" onclick={() => count--}>Decrement</button>
      </div>
    </Portal>
  {/if}
</div>
