<script lang="ts">
  // bits-ui's ToggleGroup of type "multiple" compiled from its published
  // source, through shadcn-svelte's toggle-group and toggle wrappers and the
  // multiple-selection demos (src/lib/registry: unmodified upstream sources,
  // see vendor.json), and a group bound to the app's state. The single
  // selection demos are in fixtures/bits-toggle-group-single-svelte: one
  // program uses one type (docs/design/M6-LIBRARIES.md).
  import ToggleGroupDemo from '$lib/registry/examples/toggle-group-demo.svelte';
  import ToggleGroupVertical from '$lib/registry/examples/toggle-group-vertical.svelte';
  import * as ToggleGroup from '$lib/registry/ui/toggle-group/index.js';

  let marks = $state<string[]>(['bold']);
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo" class="flex"><ToggleGroupDemo /></div>
  <div id="vertical" class="flex"><ToggleGroupVertical /></div>
  <div id="bound" class="flex gap-2">
    <ToggleGroup.Root type="multiple" bind:value={marks} onValueChange={() => changes++}>
      <ToggleGroup.Item id="bold" value="bold">Bold</ToggleGroup.Item>
      <ToggleGroup.Item id="italic" value="italic">Italic</ToggleGroup.Item>
      <ToggleGroup.Item id="underline" value="underline" disabled>Underline</ToggleGroup.Item>
      <ToggleGroup.Item id="strike" value="strike">Strike</ToggleGroup.Item>
    </ToggleGroup.Root>
    <button id="reset" class="rounded-md border px-3 py-1 text-sm" onclick={() => (marks = ['italic'])}>
      Italic only
    </button>
  </div>
  <p id="state">{marks.join(',')} {changes}</p>
</div>
