<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  let { children, ...rest }: HTMLAttributes<HTMLPreElement> = $props();
</script>

<pre class="code-block" {...rest}>{@render children?.()}</pre>
