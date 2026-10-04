<script lang="ts">
  // Focus fixup: a focused control that becomes disabled keeps focus until
  // the rendering step, which blurs it (blur, then focusout on the way up).
  let locked = $state(false);
  let log = $state<string[]>([]);
</script>

<main>
  <div class="row" onfocusout={() => log.push('row-out')}>
    <button
      id="lock"
      disabled={locked}
      onclick={() => {
        locked = true;
        log.push('click');
      }}
      onblur={() => log.push('blur')}
      onfocus={() => log.push('focus')}>Lock</button>
    <button id="unlock" onclick={() => (locked = false)}>Unlock</button>
  </div>
  <p id="log">{log.join(' ')}</p>
</main>
