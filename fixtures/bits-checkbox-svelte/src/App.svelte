<script lang="ts">
  // bits-ui's Checkbox and Label compiled from their published source,
  // through shadcn-svelte's checkbox, label and field wrappers and the
  // checkbox and label demos (src/lib/registry: unmodified upstream sources,
  // see vendor.json), and a checkbox bound to the app's state: checked and
  // indeterminate from outside, onCheckedChange counting the user's changes.
  import CheckboxDemo from '$lib/registry/examples/checkbox-demo.svelte';
  import LabelDemo from '$lib/registry/examples/label-demo.svelte';
  import { Checkbox } from '$lib/registry/ui/checkbox/index.js';
  import { Label } from '$lib/registry/ui/label/index.js';

  let checked = $state(false);
  let indeterminate = $state(true);
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo"><CheckboxDemo /></div>
  <div id="label-demo"><LabelDemo /></div>
  <div class="flex items-center gap-2">
    <Checkbox
      id="bound"
      name="bound"
      bind:checked
      bind:indeterminate
      onCheckedChange={() => changes++}
    />
    <Label id="bound-label" for="bound">Bound</Label>
  </div>
  <div class="flex gap-2">
    <button id="toggle" class="rounded-md border px-3 py-1 text-sm" onclick={() => (checked = !checked)}>
      Toggle
    </button>
    <button
      id="mixed"
      class="rounded-md border px-3 py-1 text-sm"
      onclick={() => (indeterminate = !indeterminate)}
    >
      Mixed
    </button>
  </div>
  <p id="state">{checked} {indeterminate} {changes}</p>
</div>
