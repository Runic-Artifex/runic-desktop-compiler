<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  let { children, ...rest }: HTMLAttributes<HTMLParagraphElement> = $props();
</script>

<p class="leading-relaxed [&:not(:first-child)]:mt-4" {...rest}>{@render children?.()}</p>
