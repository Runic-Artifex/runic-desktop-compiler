<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div id="account">
  <p>Account</p>
  {@render children()}
</div>
