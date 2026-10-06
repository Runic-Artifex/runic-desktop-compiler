<script lang="ts">
  // Button baselines as Chromium's (BLITZ-GAPS, fixed in the fork: button
  // baselines). Every button sits on a line between text, or in a flex row
  // aligned on baselines, once per overflow value. Next shows the next section.
  const overflows = ['visible', 'hidden', 'auto', 'clip'];
  // Rows of inline-level buttons: a label at the UA line height, a label at
  // an author line height centred in a taller button, two lines overflowing a
  // short button, empty buttons (with and without a height) and a block child.
  const inlineRows = [
    { key: 'text', content: 'text', style: '' },
    { key: 'tall', content: 'text', style: 'line-height: 24px; height: 40px;' },
    { key: 'two', content: 'two', style: 'line-height: 16px; width: 40px; height: 30px;' },
    { key: 'empty', content: 'empty', style: '' },
    { key: 'empty-tall', content: 'empty', style: 'height: 30px;' },
    { key: 'block', content: 'block', style: 'height: 30px;' },
  ];
  // Block-level buttons in flex rows aligned on their first baselines.
  const flexRows = [
    { key: 'text', content: 'text', style: '' },
    { key: 'two', content: 'two', style: 'line-height: 16px; width: 40px; height: 30px;' },
    { key: 'empty', content: 'empty', style: 'height: 30px;' },
    { key: 'block', content: 'block', style: 'height: 30px;' },
  ];
  const sections = [
    { kind: 'inline', displays: ['default', 'inline-block'] },
    { kind: 'inline', displays: ['inline-flex', 'inline-grid'] },
    { kind: 'flex', displays: ['block', 'flex', 'grid'] },
    { kind: 'other', displays: [] as string[] },
  ];
  let section = $state(0);
  const display = (d: string) => (d === 'default' ? '' : `display: ${d};`);
</script>

<div id="area" class="area">
  <p class="head"><button id="next" onclick={() => (section = (section + 1) % sections.length)}>Next</button> Section {section}</p>
  {#if sections[section].kind === 'inline'}
    {#each sections[section].displays as d (d)}
      {#each inlineRows as row (row.key)}
        <div id={`r-${d}-${row.key}`} class="line">
          Xy{#each overflows as o (o)}<button id={`b-${d}-${row.key}-${o}`} style={`${display(d)} overflow: ${o}; ${row.style}`}
              >{#if row.content === 'text'}Ab{:else if row.content === 'two'}Ab Cd{:else if row.content === 'block'}<span
                  class="box"
                ></span>{/if}</button
            >xy{/each}
        </div>
      {/each}
    {/each}
  {:else if sections[section].kind === 'flex'}
    {#each sections[section].displays as d (d)}
      {#each flexRows as row (row.key)}
        <div id={`r-${d}-${row.key}`} class="frow">
          <span class="word">Xy</span>
          {#each overflows as o (o)}<button id={`b-${d}-${row.key}-${o}`} style={`display: ${d}; overflow: ${o}; ${row.style}`}
              >{#if row.content === 'text'}Ab{:else if row.content === 'two'}Ab Cd{:else if row.content === 'block'}<span
                  class="box"
                ></span>{/if}</button
            >{/each}
        </div>
      {/each}
    {/each}
  {:else}
    <!-- floating-ui's reference E: an inline button with an author line height,
         a height and overflow: hidden, directly in a block, and content below it. -->
    <div id="ref-box" class="ref-box">
      <button id="ref" class="ref">Reference E</button>
      <div id="below" class="below">Below the reference</div>
    </div>
    <div id="r-big" class="line">
      <span class="big">Big</span><button id="b-big-hidden" style="overflow: hidden">Ab</button><button
        id="b-big-two"
        style="overflow: hidden; width: 40px; height: 30px; line-height: 16px">Ab Cd</button
      ><button id="b-big-flex" style="display: inline-flex; overflow: hidden; height: 30px"></button>xy
    </div>
    <div id="r-contain" class="line">
      Xy<button id="b-contain" style="contain: layout">Ab</button><button
        id="b-contain-flex"
        style="display: inline-flex; contain: layout">Ab</button
      ><button id="b-contain-hidden" style="contain: layout; overflow: hidden; height: 30px">Ab</button>xy
    </div>
    <div id="r-nested" class="line">
      Xy<button id="b-nested" style="height: 40px"><span class="clipped">In</span></button><button
        id="b-abs"
        style="height: 30px; position: relative"><span class="abs">A</span></button
      ><button id="b-text-block" style="height: 40px">Ab<span class="box"></span></button>xy
    </div>
    <div id="r-wrap" class="line narrow">
      Xy<button id="b-wrap" style="overflow: hidden">Words that wrap</button>xy
    </div>
    <!-- Inline grids that are not buttons: the first item of the first row
         gives the baseline, in document order and wherever it is placed. -->
    <div id="r-grid" class="line">
      Xy<span id="g-pad" class="igrid"><span class="pad">A</span><span>B</span></span><span id="g-placed" class="igrid"
        ><span class="second-row">C</span><span class="pad">D</span></span
      ><span id="g-block" class="igrid"><span class="box"></span></span>xy
    </div>
  {/if}
</div>
