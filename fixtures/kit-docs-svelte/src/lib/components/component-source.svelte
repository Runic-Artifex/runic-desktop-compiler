<script lang="ts">
  // This fixture's source viewer (the site's component-source.svelte adds a
  // file tree, a copy button and a media query): the component's files,
  // highlighted at build time by the prerendered endpoint.
  import type { HTMLAttributes } from 'svelte/elements';
  import type { HighlightedBlock } from '../../routes/api/block/[block]/+server.js';

  let { item, ...rest }: { item: HighlightedBlock } & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div id="source-{item.name}" class="flex flex-col gap-4" {...rest}>
  {#each item.files as file (file.target)}
    <figure class="flex flex-col gap-1">
      <figcaption class="text-xs text-muted-foreground">{file.target}</figcaption>
      <div class="code-block max-h-48">
        {@html file.highlightedContent}
      </div>
    </figure>
  {/each}
</div>
