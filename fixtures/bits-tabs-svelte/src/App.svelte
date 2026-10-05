<script lang="ts">
  // bits-ui's Tabs compiled from its published source, through
  // shadcn-svelte's tabs and card wrappers and the tabs demos
  // (src/lib/registry: unmodified upstream sources, see vendor.json), and
  // tabs bound to the app's state with manual activation.
  import TabsDemo from '$lib/registry/examples/tabs-demo.svelte';
  import TabsLine from '$lib/registry/examples/tabs-line.svelte';
  import TabsVertical from '$lib/registry/examples/tabs-vertical.svelte';
  import TabsDisabled from '$lib/registry/examples/tabs-disabled.svelte';
  import * as Tabs from '$lib/registry/ui/tabs/index.js';

  let value = $state('one');
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo"><TabsDemo /></div>
  <div id="line" class="flex"><TabsLine /></div>
  <div id="vertical" class="flex"><TabsVertical /></div>
  <div id="disabled" class="flex"><TabsDisabled /></div>
  <Tabs.Root id="bound" bind:value activationMode="manual" onValueChange={() => changes++}>
    <Tabs.List>
      <Tabs.Trigger id="one" value="one">One</Tabs.Trigger>
      <Tabs.Trigger id="two" value="two">Two</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="one">First panel</Tabs.Content>
    <Tabs.Content value="two">Second panel</Tabs.Content>
  </Tabs.Root>
  <button id="switch" class="w-fit rounded-md border px-3 py-1 text-sm" onclick={() => (value = value === 'one' ? 'two' : 'one')}>
    Switch
  </button>
  <p id="state">{value} {changes}</p>
</div>
