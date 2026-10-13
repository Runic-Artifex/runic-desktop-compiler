<script lang="ts">
  // shadcn-svelte's BreadcrumbLink (ui/breadcrumb/breadcrumb-link.svelte)
  // without cn and its child snippet: the href reaches the <a> through a
  // spread of a derived bag.
  import type { Snippet } from 'svelte';

  let {
    class: className,
    href = undefined,
    children,
    ...restProps
  }: {
    class?: string;
    href?: string;
    id?: string;
    children?: Snippet;
  } = $props();

  const attrs = $derived({
    'data-slot': 'breadcrumb-link',
    class: className ? `link ${className}` : 'link',
    href,
    ...restProps,
  });
</script>

<a {...attrs}>
  {@render children?.()}
</a>
