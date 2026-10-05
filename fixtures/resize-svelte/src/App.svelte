<script lang="ts">
  // ResizeObserver (M6): notifications after layout and before paint, as
  // Chromium delivers them. An observer of the outer box (content box) and
  // of its border box, a deeper element whose size the first callback
  // sets (delivered in a later round of the same frame), an element that
  // starts hidden (reported at 0×0 first), unobserve, observe again and
  // disconnect.
  let outer = $state<HTMLElement | null>(null);
  let inner = $state<HTMLElement | null>(null);
  let hidden = $state<HTMLElement | null>(null);
  let width = $state(200.5);
  let shown = $state(false);
  let innerWidth = $state(10);
  let log = $state<string[]>([]);
  let observer: ResizeObserver | null = null;

  const name = (t: HTMLElement) => (t === outer ? 'outer' : t === inner ? 'inner' : t === hidden ? 'hidden' : '?');

  const fmt = (e: ResizeObserverEntry) => {
    const r = e.contentRect;
    const b = e.borderBoxSize[0];
    const c = e.contentBoxSize[0];
    const d = e.devicePixelContentBoxSize[0];
    return `${name(e.target)} rect ${r.x},${r.y},${r.width}x${r.height} ${r.top},${r.right},${r.bottom},${r.left} border ${b.inlineSize}x${b.blockSize} content ${c.inlineSize}x${c.blockSize} device ${d.inlineSize}x${d.blockSize}`;
  };

  $effect(() => {
    if (!outer || !inner || !hidden) return;
    const content = new ResizeObserver((entries, me) => {
      for (const e of entries) {
        log.push(`content ${fmt(e)} same ${me === content}`);
        // The deeper element follows the outer box: reported in a later round.
        if (e.target === outer) innerWidth = Math.floor(e.contentRect.width / 2);
      }
    });
    const border = new ResizeObserver(entries => {
      log.push(`border ${entries.map(e => name(e.target)).join(' ')}`);
    });
    content.observe(outer);
    content.observe(inner);
    content.observe(hidden);
    border.observe(outer, { box: 'border-box' });
    observer = content;
    return () => {
      content.disconnect();
      border.disconnect();
    };
  });
</script>

<div id="app">
  <div class="controls">
    <button id="wider" onclick={() => (width += 40)}>Wider</button>
    <button id="show" onclick={() => (shown = !shown)}>Toggle hidden</button>
    <button id="unobserve" onclick={() => {
        if (outer) observer?.unobserve(outer);
      }}>Unobserve</button>
    <button id="observe" onclick={() => {
        if (outer) observer?.observe(outer);
      }}>Observe</button>
    <button id="disconnect" onclick={() => observer?.disconnect()}>Disconnect</button>
    <button id="clear" onclick={() => (log = [])}>Clear</button>
  </div>
  <div id="outer" bind:this={outer} style:width="{width}px">
    <div id="inner" bind:this={inner} style:width="{innerWidth}px"></div>
  </div>
  <div id="hidden" bind:this={hidden} class:shown></div>
  <ol id="log">
    {#each log as line, i (i)}
      <li>{line}</li>
    {/each}
  </ol>
</div>
