<script lang="ts">
  // bits-ui's ToggleGroup of type "single" compiled from its published
  // source, through shadcn-svelte's toggle-group and toggle wrappers and the
  // single-selection demos (src/lib/registry: unmodified upstream sources,
  // see vendor.json), and a group bound to the app's state. The multiple
  // selection demos are in fixtures/bits-toggle-group-svelte: one program
  // uses one type (docs/design/M6-LIBRARIES.md).
  import ToggleGroupOutline from '$lib/registry/examples/toggle-group-outline.svelte';
  import ToggleGroupSpacing from '$lib/registry/examples/toggle-group-spacing.svelte';
  import * as ToggleGroup from '$lib/registry/ui/toggle-group/index.js';

  let align = $state('left');
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="outline" class="flex"><ToggleGroupOutline /></div>
  <div id="spacing" class="flex"><ToggleGroupSpacing /></div>
  <div id="bound" class="flex gap-2">
    <ToggleGroup.Root
      type="single"
      variant="outline"
      orientation="vertical"
      bind:value={align}
      onValueChange={() => changes++}
    >
      <ToggleGroup.Item id="left" value="left">Left</ToggleGroup.Item>
      <ToggleGroup.Item id="center" value="center">Center</ToggleGroup.Item>
      <ToggleGroup.Item id="right" value="right">Right</ToggleGroup.Item>
    </ToggleGroup.Root>
    <button id="reset" class="rounded-md border px-3 py-1 text-sm" onclick={() => (align = 'center')}>
      Center
    </button>
  </div>
  <p id="state">{align} {changes}</p>
</div>
