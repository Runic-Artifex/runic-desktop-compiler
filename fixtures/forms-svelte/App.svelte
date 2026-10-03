<script lang="ts">
  let notes = $state('one\ntwo');
  let agreed = $state(false);
  let name = $state('');
  let lines = $derived(notes.split('\n').length);
</script>

<main>
  <div class="row"><label id="notes-label" for="notes">Notes</label></div>
  <div class="row"><textarea id="notes" bind:value={notes}></textarea></div>
  <p id="lines">{lines} lines</p>
  <div class="row"><label id="agree-label"><input id="agree" type="checkbox" bind:checked={agreed} /> I agree</label></div>
  <div class="row"><label id="name-label">Name <input id="name" type="text" bind:value={name} /></label></div>
  <p id="state">{agreed} {name}</p>
</main>
