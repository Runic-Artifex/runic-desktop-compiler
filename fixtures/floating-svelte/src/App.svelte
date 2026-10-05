<script lang="ts">
  // @floating-ui/dom 1.7.4 (M6 overlays): computePosition with its
  // middleware over the native layout, and autoUpdate (overflow ancestors'
  // scroll, window resize, ResizeObserver, IntersectionObserver), compared
  // with the package in Chromium. Each scenario positions a floating box
  // against a reference and logs the result.
  import {
    arrow,
    autoUpdate,
    computePosition,
    flip,
    hide,
    limitShift,
    offset,
    shift,
    size,
  } from '@floating-ui/dom';

  let log = $state<string[]>([]);
  const put = (name: string, line: string) => {
    log.push(`${name} ${line}`);
  };

  // A: absolute, in a positioned container with a border and padding.
  let refA = $state<HTMLElement | null>(null);
  let floatA = $state<HTMLElement | null>(null);
  let xA = $state(0);
  let yA = $state(0);
  let wide = $state(false);
  $effect(() => {
    if (!refA || !floatA) return;
    const reference = refA;
    const floating = floatA;
    const run = (): void => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        middleware: [offset(6), flip(), shift({ padding: 4 })],
      }).then(p => {
        xA = p.x;
        yA = p.y;
        put('A', `${p.x},${p.y} ${p.placement} ${p.strategy}`);
      });
    };
    return autoUpdate(reference, floating, run);
  });

  // B: fixed, a reference at the right edge: flipped to the left side.
  let refB = $state<HTMLElement | null>(null);
  let floatB = $state<HTMLElement | null>(null);
  let xB = $state(0);
  let yB = $state(0);
  $effect(() => {
    if (!refB || !floatB) return;
    computePosition(refB, floatB, {
      placement: 'right',
      strategy: 'fixed',
      middleware: [offset({ mainAxis: 8, crossAxis: 2 }), flip(), shift({ limiter: limitShift() })],
    }).then(p => {
      xB = p.x;
      yB = p.y;
      const f = p.middlewareData.flip;
      put('B', `${p.x},${p.y} ${p.placement} flip ${f?.index}`);
    });
  });

  // C: a reference in a scrolled container (autoUpdate on its scroll).
  let refC = $state<HTMLElement | null>(null);
  let floatC = $state<HTMLElement | null>(null);
  let xC = $state(0);
  let yC = $state(0);
  $effect(() => {
    if (!refC || !floatC) return;
    const reference = refC;
    const floating = floatC;
    // (Without layoutShift: Chromium notifies IntersectionObservers with
    // a document root in an order of its own, which A's already exercises.)
    const run = (): void => {
      computePosition(reference, floating, {
        placement: 'top',
        middleware: [offset(4), flip(), shift(), hide()],
      }).then(p => {
        xC = p.x;
        yC = p.y;
        const h = p.middlewareData.hide;
        put('C', `${p.x},${p.y} ${p.placement} hidden ${h?.referenceHidden}`);
      });
    };
    return autoUpdate(reference, floating, run, { layoutShift: false });
  });

  // D: an arrow.
  let refD = $state<HTMLElement | null>(null);
  let floatD = $state<HTMLElement | null>(null);
  let arrowD = $state<HTMLElement | null>(null);
  let xD = $state(0);
  let yD = $state(0);
  let arrowX = $state(0);
  $effect(() => {
    if (!refD || !floatD || !arrowD) return;
    computePosition(refD, floatD, {
      placement: 'top-end',
      middleware: [offset(10), arrow({ element: arrowD, padding: 4 })],
    }).then(p => {
      xD = p.x;
      yD = p.y;
      const a = p.middlewareData.arrow;
      arrowX = a?.x ?? 0;
      put('D', `${p.x},${p.y} ${p.placement} arrow ${a?.x},${a?.y} ${a?.centerOffset}`);
    });
  });

  // E: size, which limits the height to the space below.
  let refE = $state<HTMLElement | null>(null);
  let floatE = $state<HTMLElement | null>(null);
  let xE = $state(0);
  let yE = $state(0);
  $effect(() => {
    if (!refE || !floatE) return;
    const floating = floatE;
    computePosition(refE, floating, {
      placement: 'bottom',
      middleware: [
        size({
          padding: 6,
          apply({ availableWidth, availableHeight }) {
            floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
            put('E', `available ${availableWidth},${availableHeight}`);
          },
        }),
      ],
    }).then(p => {
      xE = p.x;
      yE = p.y;
      put('E', `${p.x},${p.y} ${p.placement}`);
    });
  });
</script>

<div id="app">
  <div class="controls">
    <button id="wider" onclick={() => (wide = !wide)}>Wider</button>
    <button id="clear" onclick={() => (log = [])}>Clear</button>
  </div>
  <div class="box" id="boxA">
    <button id="refA" class="ref" class:wide bind:this={refA}>Reference A</button>
    <div class="float" bind:this={floatA} style:left="{xA}px" style:top="{yA}px">Floating A</div>
  </div>
  <button id="refB" class="ref edge" bind:this={refB}>B</button>
  <div class="float fixed" bind:this={floatB} style:left="{xB}px" style:top="{yB}px">Floating B</div>
  <div class="scroller" id="scroller">
    <div class="spacer"></div>
    <button id="refC" class="ref" bind:this={refC}>Reference C</button>
    <div class="spacer"></div>
  </div>
  <div class="float" bind:this={floatC} style:left="{xC}px" style:top="{yC}px">Floating C</div>
  <div class="box">
    <button id="refD" class="ref" bind:this={refD}>Reference D, wide</button>
  </div>
  <div class="float" bind:this={floatD} style:left="{xD}px" style:top="{yD}px">
    Floating D
    <div class="arrow" bind:this={arrowD} style:left="{arrowX}px"></div>
  </div>
  <button id="refE" class="ref" bind:this={refE}>Reference E</button>
  <div class="float tall" bind:this={floatE} style:left="{xE}px" style:top="{yE}px">
    <div class="content">Floating E, taller than the space below it</div>
  </div>
  <ol id="log">
    {#each log as line, i (i)}
      <li>{line}</li>
    {/each}
  </ol>
</div>
