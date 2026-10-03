<script lang="ts">
  let { value = $bindable('') }: { value?: string } = $props();
  let edits = $state(0);
</script>
<p><input id="name" aria-label="Name" type="text" bind:value oninput={() => edits += 1} /></p>
<p id="edits">Edits: {edits}</p>
