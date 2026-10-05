<script lang="ts">
  // bits-ui's Accordion of type "multiple" compiled from its published
  // source, through shadcn-svelte's accordion wrappers and the
  // accordion-multiple demo (src/lib/registry: unmodified upstream sources,
  // see vendor.json), and an accordion bound to the app's state. The
  // single-item demos are in fixtures/bits-accordion-svelte: one program uses
  // one type (docs/design/M6-LIBRARIES.md).
  //
  // The accordions mount when "Show" is pressed: bits-ui measures open
  // content while it mounts, and Chromium lays the page out with a fallback
  // font until the app's font has loaded, which is after the app mounted
  // (native builds have their fonts from the start; docs/BLITZ-GAPS.md).
  import AccordionMultiple from '$lib/registry/examples/accordion-multiple.svelte';
  import * as Accordion from '$lib/registry/ui/accordion/index.js';

  let shown = $state(false);
  let open = $state<string[]>(['c']);
  let changes = $state(0);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <button id="show" class="w-fit rounded-md border px-3 py-1 text-sm" onclick={() => (shown = true)}>
    Show
  </button>
  {#if shown}
    <div id="multiple"><AccordionMultiple /></div>
    <div id="bound" class="flex flex-col gap-2">
      <Accordion.Root type="multiple" bind:value={open} onValueChange={() => changes++}>
        <Accordion.Item value="a">
          <Accordion.Trigger id="a">First</Accordion.Trigger>
          <Accordion.Content>The first panel.</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="b" disabled>
          <Accordion.Trigger id="b">Second (disabled)</Accordion.Trigger>
          <Accordion.Content>The second panel.</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="c">
          <Accordion.Trigger id="c">Third</Accordion.Trigger>
          <Accordion.Content>The third panel.</Accordion.Content>
        </Accordion.Item>
      </Accordion.Root>
      <button id="reset" class="w-fit rounded-md border px-3 py-1 text-sm" onclick={() => (open = ['b', 'c'])}>
        Open the second and third
      </button>
      <p id="state">{open.join(',')} {changes}</p>
    </div>
  {/if}
</div>
