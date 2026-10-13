<script lang="ts">
  // A raw object passed as a prop and mutated by the child is not reactive
  // in Svelte; a $state object passed the same way is.
  import Child from './Child.svelte';

  const raw = { count: 0 };
  let owned = $state({ count: 0 });
  let other = $state(0);
</script>

<main>
  <h1 id="title">Props of raw and proxied objects</h1>
  <Child id="raw" item={raw} {other} />
  <Child id="owned" item={owned} {other} />
  <p id="parent">{owned.count} {other}</p>
  <div class="controls">
    <button id="other" onclick={() => (other += 1)}>Other</button>
  </div>
</main>
