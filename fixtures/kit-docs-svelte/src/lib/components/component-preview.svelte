<script lang="ts">
  // This fixture's preview (the site's component-preview-tabs.svelte uses
  // tooltips and its user config): the example the previews preprocessor
  // passes as `component`, and its source (the markdown's code figure).
  import type { Component, Snippet } from 'svelte';

  let {
    name,
    component,
    children,
  }: { name: string; component?: Component; children?: Snippet } = $props();

  const Example = $derived(component);
</script>

<div id="preview-{name}" class="mt-4 mb-10 flex flex-col overflow-hidden rounded-xl border">
  <div data-slot="preview" class="flex min-h-[220px] w-full items-center justify-center p-10">
    {#if Example}
      <Example />
    {:else}
      <p class="text-sm text-muted-foreground">Component {name} not found in registry.</p>
    {/if}
  </div>
  <div data-slot="code" class="max-h-60 overflow-hidden border-t">
    {@render children?.()}
  </div>
</div>
