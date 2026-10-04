<script lang="ts">
  // Shared-layer parts that bits-ui's ToggleGroup and shadcn-svelte's
  // wrappers use, without layout reads (the differential harness checks the
  // generated code against the interpreter): see group.svelte.ts and
  // Group.svelte.
  import { boxWith, type WritableBox } from 'svelte-toolbelt';
  import Group from './Group.svelte';
  import Item from './Item.svelte';
  import { createGroup } from './group.svelte.ts';

  let marks = $state<string[]>(['bold']);
  let changes = $state(0);
  let size = $state('m');

  // A single group made directly: the other subclass, in the same program.
  const sizes = createGroup({
    type: 'single',
    value: boxWith(
      () => size,
      (v: string) => (size = v),
    ) as WritableBox<string> | WritableBox<string[]>,
    name: boxWith(() => 'size'),
    loop: boxWith(() => false),
  });
</script>

<main>
  <h1>Options hierarchy</h1>
  <Group type="multiple" name="marks" bind:value={marks} onValueChange={() => changes++}>
    <Item value="bold" />
    <Item value="italic" tone="loud" />
    <Item value="strike" />
  </Group>
  <Group type="multiple" name="extra" tone="loud">
    <Item value="one" />
    <Item value="two" />
  </Group>
  <div class="controls">
    {#each ['s', 'm', 'l'] as s (s)}
      <button id="size-{s}" class={sizes.includes(s) ? 'current' : ''} onclick={() => sizes.toggle(s)}>
        {s}
      </button>
    {/each}
    <button id="reset" onclick={() => (marks = ['italic'])}>Italic only</button>
    <button id="clear" onclick={() => (marks = [])}>Clear</button>
  </div>
  <p id="state">{marks.join(',')} {changes} {size} {sizes.label} {sizes.anyPressed}</p>
  <p id="first">{marks[0] === 'bold' ? 'bold first' : 'other first'}</p>
</main>
