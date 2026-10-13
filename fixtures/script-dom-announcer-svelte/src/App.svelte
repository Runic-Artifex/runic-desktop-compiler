<script lang="ts">
  // Script DOM, slice 1 (docs/design/M6-SCRIPT-DOM.md): bits-ui's announcer
  // (a document value that may be null, nodes created by script and placed
  // at the start of the body, innerText, replaceChildren, remove from a
  // timer) and a log that script builds inside an element the template
  // renders without children (a script host).
  import { getAnnouncer } from './announcer';

  // As the calendar root's constructor does before it is mounted.
  let announcer = getAnnouncer(null);
  let count = $state(0);
  let status = $state('none');
  let host = $state<HTMLElement | null>(null);

  function report(): void {
    const region = document.querySelector('[data-bits-announcer]');
    status = region ? `${region.textContent}|${region.firstChild === null}` : 'none';
  }

  function attach(): void {
    announcer = getAnnouncer(document);
    report();
  }

  function say(): void {
    count += 1;
    announcer.announce(`  Value ${count} `);
    report();
  }

  function polite(): void {
    announcer.announce('Two\nlines', 'polite', 500);
    report();
  }

  function empty(): void {
    announcer.announce(null);
    report();
  }

  function addLine(): void {
    if (!host) return;
    const line = document.createElement('p');
    line.className = 'line';
    line.textContent = `line ${host.childElementCount + 1}`;
    host.insertBefore(line, host.firstChild);
  }

  function clearLines(): void {
    host?.replaceChildren();
  }
</script>

<div id="app">
  <button id="attach" onclick={attach}>attach</button>
  <button id="say" onclick={say}>say</button>
  <button id="polite" onclick={polite}>polite</button>
  <button id="empty" onclick={empty}>empty</button>
  <button id="report" onclick={report}>report</button>
  <button id="add" onclick={addLine}>add</button>
  <button id="clear" onclick={clearLines}>clear</button>
  <p id="count">{count}</p>
  <p id="status">{status}</p>
  <div id="host" class="host" bind:this={host}></div>
</div>
