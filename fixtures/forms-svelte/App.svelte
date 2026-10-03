<script lang="ts">
  let notes = $state('one\ntwo');
  let agreed = $state(false);
  let name = $state('');
  let lines = $derived(notes.split('\n').length);
  let frozen = $state(false);
  let fixed = $state('fixed');
  let other = $state(0);
</script>

<main>
  <div class="row"><label id="notes-label" for="notes">Notes</label></div>
  <div class="row"><textarea id="notes" bind:value={notes}></textarea></div>
  <p id="lines">{lines} lines</p>
  <div class="row"><label id="agree-label"><input id="agree" type="checkbox" bind:checked={agreed} /> I agree</label></div>
  <div class="row"><label id="name-label">Name <input id="name" type="text" bind:value={name} /></label></div>
  <div class="row"><input id="frozen" type="checkbox" aria-label="Frozen" checked={frozen} /><input id="fixed" type="text" aria-label="Fixed" value={fixed} /><button id="other" onclick={() => other++}>Other {other}</button></div>
  <p id="state">{agreed} {name}</p>
</main>
