<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  let { children, ...rest }: HTMLAttributes<HTMLHeadingElement> = $props();
</script>

<h2 class="mt-10 text-xl font-medium tracking-tight first:mt-0" {...rest}>{@render children?.()}</h2>
