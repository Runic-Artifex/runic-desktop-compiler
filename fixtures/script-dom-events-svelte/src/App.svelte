<script lang="ts">
  // Script DOM, slice 3 (docs/design/M6-SCRIPT-DOM.md): listeners script
  // adds with options (capture, once, passive) on elements, the document and
  // the window, removed by (type, listener, capture); events script creates
  // (Event, CustomEvent with a typed detail, MouseEvent with init members)
  // dispatched at rendered elements, script nodes and the document;
  // template listeners of custom event types; feature tests of host objects.
  import { onMount } from 'svelte';

  type Tick = { n: number; label: string };

  let zone = $state<HTMLElement | null>(null);
  let inner = $state<HTMLElement | null>(null);
  let free = $state<HTMLElement | null>(null);
  let spot = $state<HTMLElement | null>(null);
  let held = $state<HTMLElement | null>(null);
  let cancelled = $state<HTMLElement | null>(null);
  let log = $state('');
  let ticks = $state('');
  let n = 0;
  let script: HTMLElement | null = null;

  function note(line: string): void {
    log = log ? `${log} / ${line}` : line;
  }

  // Listeners on the zone's path (no template listener is on it).
  function onCapture(e: MouseEvent): void {
    note(`capture ${e.type} ${e.isTrusted} ${e.currentTarget === zone}`);
  }
  function onBubble(e: MouseEvent): void {
    note(`bubble ${e.button} ${e.target === inner}`);
  }
  function onOnce(): void {
    note('once');
  }
  function onPassive(e: MouseEvent): void {
    e.preventDefault();
    note(`passive ${e.defaultPrevented}`);
  }
  function onCancel(e: MouseEvent): void {
    e.preventDefault();
    note(`cancel ${e.defaultPrevented}`);
  }
  function onKey(e: KeyboardEvent): void {
    note(`key ${e.key}`);
  }
  function onWindowClick(e: MouseEvent): void {
    note(`window ${e.cancelable} ${e.isTrusted}`);
  }
  function onPing(e: Event): void {
    const at = e.currentTarget === script ? 'span' : e.currentTarget === spot ? 'spot' : 'other';
    note(`ping ${at} ${e.bubbles} ${e.target === script}`);
  }
  function onDocumentPing(e: Event): void {
    note(`document ping ${e.target === script}`);
  }
  // A template listener of a custom type (`ontick` below).
  function onTick(e: CustomEvent<Tick>): void {
    ticks = `${ticks}[${e.detail.label} ${e.detail.n}]`;
  }
  function onFreeTick(e: CustomEvent<Tick>): void {
    if (e.detail.n % 2 === 0) e.preventDefault();
    note(`free ${e.detail.n} ${e.cancelable}`);
  }
  function onFreeClick(e: MouseEvent): void {
    // (A click by the user is at a point of the layout: not shown.)
    note(`free click ${e.isTrusted ? 'user' : String(e.clientX)} ${e.ctrlKey} ${e.isTrusted}`);
  }

  onMount(() => {
    if (!zone || !inner || !held || !cancelled || !free || !spot) return;
    zone.addEventListener('click', onCapture, { capture: true });
    zone.addEventListener('click', onCapture, true);
    zone.addEventListener('click', onBubble);
    inner.addEventListener('click', onOnce, { once: true });
    held.addEventListener('click', onPassive, { passive: true });
    cancelled.addEventListener('click', onCancel, { passive: false });
    free.addEventListener('tick', onFreeTick);
    free.addEventListener('click', onFreeClick);
    spot.addEventListener('ping', onPing);
    document.addEventListener('keydown', onKey, { once: true });
    document.addEventListener('ping', onDocumentPing);
    window.addEventListener('click', onWindowClick, { capture: true, passive: true });
    note(`features ${'addEventListener' in zone} ${typeof window.MouseEvent}`);
  });

  function unhook(): void {
    if (!zone) return;
    // (Removed by type, listener and capture: the first leaves the capture
    // listener, the second removes it.)
    zone.removeEventListener('click', onCapture);
    zone.removeEventListener('click', onCapture, { capture: true });
    note('unhooked');
  }

  function custom(): void {
    if (!free) return;
    n += 1;
    const tick = new CustomEvent<Tick>('tick', {
      bubbles: true,
      cancelable: true,
      detail: { n, label: 'tick' },
    });
    const kept = free.dispatchEvent(tick);
    const quiet = new CustomEvent<Tick>('tick', { detail: { n: n * 10, label: 'quiet' } });
    const quietKept = free.dispatchEvent(quiet);
    note(`custom ${kept} ${tick.defaultPrevented} ${quietKept} ${tick.isTrusted}`);
  }

  function native(): void {
    if (!free) return;
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 7,
      ctrlKey: true,
    });
    const kept = free.dispatchEvent(click);
    note(`native ${kept} ${click.clientX} ${click.isTrusted}`);
  }

  function nodes(): void {
    if (!free || !spot) return;
    if (!script) {
      script = document.createElement('span');
      script.textContent = 'script';
      spot.append(script);
      script.addEventListener('ping', onPing);
    }
    script.dispatchEvent(new Event('ping', { bubbles: true }));
    script.dispatchEvent(new Event('ping'));
    let error = '';
    const nested = new Event('nested');
    const reenter = (): void => {
      try {
        free?.dispatchEvent(nested);
      } catch (x) {
        error = (x as Error).name;
      }
    };
    free.addEventListener('nested', reenter);
    free.dispatchEvent(nested);
    const again = free.dispatchEvent(nested);
    free.removeEventListener('nested', reenter);
    note(`nodes ${error} ${again}`);
  }
</script>

<div id="app">
  <button id="unhook" onclick={unhook}>unhook</button>
  <button id="custom" onclick={custom}>custom</button>
  <button id="native" onclick={native}>native</button>
  <button id="nodes" onclick={nodes}>nodes</button>
  <div id="zone" class="zone" bind:this={zone}>
    <span id="inner" class="inner" bind:this={inner}>inner</span>
    <input id="held" type="checkbox" bind:this={held} />
    <input id="cancelled" type="checkbox" bind:this={cancelled} />
  </div>
  <div id="ticks" class="ticks" ontick={onTick}>
    <div id="free" class="free" bind:this={free}>free</div>
    <div id="spot" class="spot" bind:this={spot}></div>
  </div>
  <p id="log">{log}</p>
  <p id="tick-log">{ticks}</p>
</div>
