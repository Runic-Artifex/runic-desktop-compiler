<script lang="ts">
  // bits-ui's Collapsible compiled from its published source, through
  // shadcn-svelte's collapsible wrapper and its demo (src/lib/registry:
  // unmodified upstream sources, see vendor.json). The demo opens and
  // closes through a `child` snippet that renders shadcn's Button with the
  // trigger's props; the second collapsible uses the default elements,
  // explicit ids and `bind:open`, read here and written from outside.
  import CollapsibleDemo from '$lib/registry/examples/collapsible-demo.svelte';
  import * as Collapsible from '$lib/registry/ui/collapsible/index.js';

  let open = $state(true);
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo"><CollapsibleDemo /></div>
  <Collapsible.Root
    id="faq"
    bind:open
    onOpenChange={() => changes++}
    class="flex w-[350px] flex-col gap-2 rounded-md border p-2 data-[state=open]:bg-muted"
  >
    <Collapsible.Trigger id="faq-trigger" class="rounded-md border px-3 py-1 text-left text-sm">
      Can I use it in a project?
    </Collapsible.Trigger>
    <Collapsible.Content id="faq-content" class="px-3 text-sm text-muted-foreground">
      Yes. It is free and open source.
    </Collapsible.Content>
  </Collapsible.Root>
  <button id="toggle" class="w-fit rounded-md border px-3 py-1 text-sm" onclick={() => (open = !open)}>
    Toggle from outside
  </button>
  <p id="state">{open} {changes}</p>
</div>
