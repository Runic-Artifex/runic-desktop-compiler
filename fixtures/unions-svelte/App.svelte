<script lang="ts">
  import { Store, describe } from './values.svelte.ts';
  import { Anchor } from './anchor.svelte.ts';

  const store = new Store();
  let empty = $state(false);
  const anchor = new Anchor();
  let box: HTMLElement | undefined = $state();
</script>

<main>
  <h1>Unions</h1>
  <div class="row">
    <button id="set-number" onclick={() => store.set(7)}>7</button>
    <button id="set-zero" onclick={() => store.set(0)}>0</button>
    <button id="set-string" onclick={() => store.set('  ten ')}>ten</button>
    <button id="set-digits" onclick={() => store.set('7')}>"7"</button>
    <button id="bump" onclick={() => store.bump()}>bump</button>
    <button id="empty" onclick={() => (empty = !empty)}>empty</button>
  </div>
  <p id="value">value: {store.value}</p>
  <p id="typeof">typeof: {typeof store.value}</p>
  <p id="string">String: {String(store.value)}</p>
  <p id="number">Number: {Number(store.value)}</p>
  <p id="truthy">truthy: {store.value ? 'yes' : 'no'}</p>
  <p id="plus">+ 1: {store.value + 1} prefixed: {'#' + store.value}</p>
  <p id="compare">&lt; 10: {store.value < 10} &gt;= "5": {store.value >= '5'}</p>
  <p id="seven">=== 7: {store.value === 7} === "7": {store.value === '7'}</p>
  <p id="describe">{describe(empty ? null : store.value)}</p>
  <p id="history">{store.history.join(', ')}</p>
  <div class="box" bind:this={box}></div>
  <div class="row">
    <button id="anchor-element" onclick={() => {
        if (box) anchor.useElement(box);
      }}>element</button>
    <button id="anchor-point" onclick={() => anchor.usePoint(12, 34)}>point</button>
    <button id="anchor-far" onclick={() => anchor.usePoint(200, 5)}>far</button>
  </div>
  <p id="anchor">{anchor.describe()}</p>
</main>
