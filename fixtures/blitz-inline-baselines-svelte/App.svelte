<script lang="ts">
  // Inline baselines as Chromium's (BLITZ-GAPS, fixed in the fork: inline
  // baselines). Atomic inlines alone in a block or after text, and text
  // inputs, sit on their lines by their baselines: the same rows in block
  // flow, as the items of a flex column (measured before their final layout)
  // and of flex rows.
  const contexts = ['flow', 'column'];
</script>

{#each contexts as c (c)}
  <div id={`g-${c}`} class={c}>
    <div id={`${c}-ifx`} class="line"><span id={`${c}-ifx-box`} class="ifx">Open</span></div>
    <div id={`${c}-igrid`} class="line"><span id={`${c}-igrid-box`} class="igrid">Grid</span></div>
    <div id={`${c}-iblock`} class="line"><span id={`${c}-iblock-box`} class="iblock">Block</span></div>
    <div id={`${c}-button`} class="line"><button id={`${c}-button-box`}>Save</button></div>
    <div id={`${c}-input`} class="line"><input id={`${c}-input-box`} class="full" value="Pedro Duarte" /></div>
    <div id={`${c}-empty`} class="line"><input id={`${c}-empty-box`} class="narrow" /></div>
    <div id={`${c}-tall`} class="line"><input id={`${c}-tall-box`} class="narrow tall" value="tall" /></div>
    <div id={`${c}-text`} class="line">Xy <input id={`${c}-text-box`} class="narrow" value="@peduarte" /> z</div>
    <div id={`${c}-mixed`} class="line">Ab <span id={`${c}-mixed-box`} class="ifx">Open</span> <input id={`${c}-mixed-input`} class="narrow" value="v" /></div>
  </div>
{/each}
<div id="g-row" class="row">
  <div id="row-ifx" class="line"><span id="row-ifx-box" class="ifx">Open</span></div>
  <div id="row-igrid" class="line"><span id="row-igrid-box" class="igrid">Grid</span></div>
  <div id="row-iblock" class="line"><span id="row-iblock-box" class="iblock">Block</span></div>
  <div id="row-button" class="line"><button id="row-button-box">Save</button></div>
</div>
<div id="g-row2" class="row">
  <div id="row-empty" class="line"><input id="row-empty-box" class="narrow" /></div>
  <div id="row-tall" class="line"><input id="row-tall-box" class="narrow tall" value="tall" /></div>
  <div id="row-text" class="line">Xy <input id="row-text-box" class="narrow" value="@pe" /></div>
</div>
