<script lang="ts">
  import type { HTMLAnchorAttributes } from "svelte/elements";

  let { children, ...rest }: HTMLAnchorAttributes = $props();
</script>

<a class="font-medium underline underline-offset-4" {...rest}>{@render children?.()}</a>
