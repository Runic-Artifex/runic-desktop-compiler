<script lang="ts">
  let log = $state<string[]>([]);
  let field = $state<HTMLInputElement | null>(null);
</script>

<main>
  <div class="row" onfocusin={() => log.push('row-in')} onfocusout={() => log.push('row-out')}>
    <button id="a" onfocus={() => log.push('a-focus')} onblur={() => log.push('a-blur')} onclick={() => { log.push('a-click'); field?.focus(); log.push('a-after'); }}>A</button>
    <input id="field" type="text" aria-label="Field" bind:this={field} onfocus={(e) => log.push(`field-focus ${e.relatedTarget !== null}`)} onblur={() => log.push('field-blur')} />
    <div id="box" tabindex="0" onfocus={() => log.push('box-focus')} onblur={(e) => log.push(`box-blur ${e.relatedTarget === null}`)}>Box</div>
  </div>
  <p id="plain">Plain</p>
  <p id="log">{log.join(' ')}</p>
</main>
