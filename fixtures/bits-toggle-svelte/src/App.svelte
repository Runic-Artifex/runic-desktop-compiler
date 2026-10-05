<script lang="ts">
  // bits-ui's Toggle compiled from its published source, through
  // shadcn-svelte's toggle wrapper and its demos (src/lib/registry:
  // unmodified upstream sources, see vendor.json), and a toggle bound to the
  // app's state (bind:pressed, onPressedChange, disabled from outside).
  // The main demo (toggle-demo) is rejected: it fills its icon through CSS
  // (a Tailwind fill utility on the icon), which Blitz does not apply to
  // inline SVG (E_CSS_PROPERTY).
  import ToggleSm from '$lib/registry/examples/toggle-sm.svelte';
  import ToggleLg from '$lib/registry/examples/toggle-lg.svelte';
  import ToggleOutline from '$lib/registry/examples/toggle-outline.svelte';
  import ToggleWithText from '$lib/registry/examples/toggle-with-text.svelte';
  import ToggleDisabled from '$lib/registry/examples/toggle-disabled.svelte';
  import { Toggle } from '$lib/registry/ui/toggle/index.js';

  let pressed = $state(false);
  let disabled = $state(false);
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="sizes" class="flex gap-2"><ToggleSm /><ToggleLg /></div>
  <div id="outline"><ToggleOutline /></div>
  <div id="text" class="flex"><ToggleWithText /></div>
  <div id="disabled" class="flex"><ToggleDisabled /></div>
  <div id="row" class="flex items-center gap-2">
    <Toggle
      id="bound"
      size="lg"
      bind:pressed
      {disabled}
      onPressedChange={() => changes++}
    >
      Wrap
    </Toggle>
    <button id="press" class="rounded-md border px-3 py-1 text-sm" onclick={() => (pressed = !pressed)}>
      Press
    </button>
    <button id="disable" class="rounded-md border px-3 py-1 text-sm" onclick={() => (disabled = !disabled)}>
      Disable
    </button>
  </div>
  <p id="state">{pressed} {disabled} {changes}</p>
</div>
