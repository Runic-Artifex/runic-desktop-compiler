<script lang="ts">
  // bits-ui's Separator compiled from its published source, through
  // shadcn-svelte's separator wrapper and two of its demos (src/lib/registry:
  // unmodified upstream sources, see vendor.json), and the wrapper with
  // orientation and decorative changed from outside.
  import SeparatorDemo from '$lib/registry/examples/separator-demo.svelte';
  import SeparatorVertical from '$lib/registry/examples/separator-vertical.svelte';
  import { Separator } from '$lib/registry/ui/separator/index.js';

  let vertical = $state(false);
  let decorative = $state(false);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo"><SeparatorDemo /></div>
  <div id="vertical"><SeparatorVertical /></div>
  <div class="flex h-10 flex-col gap-2 data-[v=true]:flex-row" data-v={vertical}>
    <span>Left</span>
    <Separator
      id="dynamic"
      orientation={vertical ? 'vertical' : 'horizontal'}
      {decorative}
      class="bg-primary"
    />
    <span>Right</span>
  </div>
  <div class="flex gap-2">
    <button id="orientation" class="rounded-md border px-3 py-1 text-sm" onclick={() => (vertical = !vertical)}>
      Orientation
    </button>
    <button id="decorative" class="rounded-md border px-3 py-1 text-sm" onclick={() => (decorative = !decorative)}>
      Decorative
    </button>
  </div>
</div>
