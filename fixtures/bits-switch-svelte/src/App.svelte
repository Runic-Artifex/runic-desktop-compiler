<script lang="ts">
  // bits-ui's Switch compiled from its published source, through
  // shadcn-svelte's switch and label wrappers and the switch demo
  // (src/lib/registry: unmodified upstream sources, see vendor.json), and
  // switches bound to the app's state: a small one with a name (its hidden
  // input), and a disabled one.
  import SwitchDemo from '$lib/registry/examples/switch-demo.svelte';
  import { Switch } from '$lib/registry/ui/switch/index.js';
  import { Label } from '$lib/registry/ui/label/index.js';

  let checked = $state(true);
  let disabled = $state(false);
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo"><SwitchDemo /></div>
  <div id="row" class="flex items-center gap-2">
    <Switch
      id="bound"
      name="bound"
      size="sm"
      bind:checked
      {disabled}
      onCheckedChange={() => changes++}
    />
    <Label id="bound-label" for="bound">Notifications</Label>
  </div>
  <div class="flex gap-2">
    <button id="toggle" class="rounded-md border px-3 py-1 text-sm" onclick={() => (checked = !checked)}>
      Toggle
    </button>
    <button id="disable" class="rounded-md border px-3 py-1 text-sm" onclick={() => (disabled = !disabled)}>
      Disable
    </button>
  </div>
  <p id="state">{checked} {disabled} {changes}</p>
</div>
