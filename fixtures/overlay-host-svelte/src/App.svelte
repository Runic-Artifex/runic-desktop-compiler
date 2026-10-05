<script lang="ts">
  // The host APIs bits-ui's overlay layers use (M6 overlays): svelte/events'
  // `on` for the document (capture and bubble) and elements, script events
  // (`CustomEvent`), tabbable, a MutationObserver of a child list,
  // `document.activeElement`, `contains`, a lazily created static singleton
  // and a WeakMap, compared with Chromium.
  import { on } from 'svelte/events';
  import { focusable, isFocusable, isTabbable, tabbable } from 'tabbable';
  import { Registry } from './registry';

  let log = $state<string[]>([]);
  let items = $state([1, 2, 3]);
  let next = 4;
  let box = $state<HTMLElement | null>(null);
  let listening = $state(false);
  let mutations = $state(0);
  let stop: (() => void) | null = null;

  const name = (el: HTMLElement | null) => (el ? el.id || el.localName : 'none');

  $effect(() => {
    if (!box) return;
    const target = box;
    const observer = new MutationObserver(() => {
      mutations += 1;
      log.push(`mutation ${mutations}`);
    });
    observer.observe(target, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  function listen(): void {
    if (!box) return;
    const target = box;
    const offCapture = on(
      document,
      'focusin',
      e => log.push(`capture focusin ${name(e.target)}`),
      { capture: true },
    );
    const offBubble = on(document, 'focusin', e => log.push(`bubble focusin ${name(e.target)}`));
    const offKey = on(target, 'keydown', e => {
      log.push(`box keydown ${e.key}`);
      if (e.key === 'x') e.preventDefault();
    });
    stop = () => {
      offCapture();
      offBubble();
      offKey();
    };
    listening = true;
  }

  function unlisten(): void {
    stop?.();
    stop = null;
    listening = false;
  }

  function report(): void {
    if (!box) return;
    const ids = (list: HTMLElement[]) => list.map(e => name(e)).join(',');
    log.push(`tabbable ${ids(tabbable(box))}`);
    log.push(`focusable ${ids(focusable(box, { includeContainer: true }))}`);
    const first = box.querySelector('button');
    if (first) log.push(`first ${name(first)} ${isTabbable(first)} ${isFocusable(first)}`);
    const active = document.activeElement;
    log.push(`active ${name(active)} inside ${box.contains(active)}`);
    const event = new CustomEvent('custom.check', { bubbles: false, cancelable: true });
    decide(event);
    log.push(`custom ${event.type} prevented ${event.defaultPrevented}`);
    if (active) log.push(`seen ${Registry.get().count(active)}`);
  }

  function decide(e: Event): void {
    if (items.length > 2) e.preventDefault();
  }
</script>

<div id="app">
  <div class="controls">
    <button id="add" onclick={() => { items.push(next); next += 1; }}>Add</button>
    <button id="remove" onclick={() => items.shift()}>Remove</button>
    <button id="listen" onclick={listen} disabled={listening}>Listen</button>
    <button id="unlisten" onclick={unlisten}>Unlisten</button>
    <button id="report" onclick={report}>Report</button>
    <button id="clear" onclick={() => (log = [])}>Clear</button>
  </div>
  <div id="box" tabindex="-1" bind:this={box}>
    {#each items as item (item)}
      <button id={`item${item}`} class="item">Item {item}</button>
    {/each}
    <button id="hidden" class="hidden">Hidden</button>
    <span id="later" tabindex="2">Later</span>
    <button id="off" disabled>Off</button>
  </div>
  <ol id="log">
    {#each log as line, i (i)}
      <li>{line}</li>
    {/each}
  </ol>
</div>
