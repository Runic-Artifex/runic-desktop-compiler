<script module>
  // The markdown blueprint (mdsx.config.js): the components markdown
  // elements become. This fixture's (the site's blueprint renders a legacy
  // <slot> and code blocks with tooltip copy buttons).
  export { a, h2, p, pre } from './index.js';
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<div class="mdsx">
  {@render children?.()}
</div>
