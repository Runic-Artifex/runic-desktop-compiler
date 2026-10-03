<script lang="ts">
  let log = $state<string[]>([]);
  let stop = $state(false);
  let locked = $state(true);
  let agreed = $state(false);
  let text = $state('');
  let hovers = $state(0);
  let inside = $state(false);
  let doubles = $state(0);
  let menus = $state(0);
  let scrolled = $state(0);
  let closed = $state(false);
  let later = $state('');

  function onKey(e: KeyboardEvent) {
    log.push(`${e.type}:${e.key}:${e.code}${e.shiftKey ? '+shift' : ''}${e.repeat ? '+repeat' : ''}`);
    if (e.key === 'x') e.preventDefault();
  }
</script>

<main>
  <div id="outer" onclick={(e) => { log.push('outer'); if (e.target === e.currentTarget) closed = true; }}>
    <button id="inner" onclick={(e) => { log.push('inner'); if (stop) e.stopPropagation(); }}>Inner</button>
  </div>
  <div class="row">
    <button id="stop" onclick={() => (stop = !stop)}>Stop: {stop}</button>
    <button id="lock" onclick={() => (locked = !locked)}>Locked: {locked}</button>
    <input id="agree" type="checkbox" aria-label="Agree" bind:checked={agreed} onclick={(e) => { if (locked) e.preventDefault(); }} />
  </div>
  <div class="row">
    <input id="field" type="text" aria-label="Field" bind:value={text} onkeydown={onKey} onkeyup={onKey} />
    <button id="keep" onmousedown={(e) => e.preventDefault()} onclick={() => log.push('keep')}>Keep focus</button>
  </div>
  <div id="box" onpointerenter={() => { hovers++; inside = true; }} onpointerleave={() => (inside = false)} ondblclick={() => doubles++} oncontextmenu={(e) => { e.preventDefault(); menus++; }} onwheel={(e) => { e.preventDefault(); scrolled += e.deltaY; }}>Box {hovers} {inside} {doubles} {menus} {scrolled}</div>
  <div class="row">
    <button id="late" onclick={(e) => setTimeout(() => (later = `${e.type} ${e.currentTarget === null} ${e.defaultPrevented}`), 0)}>Later</button>
    <button id="enter" onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} onclick={() => log.push('enter-click')}>No enter</button>
  </div>
  <p id="state">{closed} {agreed} {text} {later}</p>
  <p id="log">{log.join(' ')}</p>
</main>
