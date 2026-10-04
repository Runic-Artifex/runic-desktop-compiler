<script lang="ts">
  // Svelte compares a derived value's results with ===: NaN never equals
  // itself, so dependents of an always-NaN derived re-run on every input
  // change; -0 equals 0, so a derived that flips between them does not.
  let n = $state(0);
  const nan = $derived(n * NaN);
  const zero = $derived(n % 2 === 0 ? 0 : -0);
  $effect(() => {
    nan;
    console.log('nan effect');
  });
  $effect(() => {
    zero;
    console.log('zero effect');
  });
</script>

<div class="row"><button id="inc" onclick={() => n++}>n = {n}</button></div>
