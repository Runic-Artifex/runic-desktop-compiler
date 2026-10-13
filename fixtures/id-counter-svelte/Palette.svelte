<script lang="ts">
  import { Command } from 'bits-ui';
  import Group from './Group.svelte';

  let { name }: { name: string } = $props();
</script>

<Command.Root class="palette" label={name}>
  <Command.List>
    <Group>
      <Command.Item class="item" value={`${name} alpha`}>{name} alpha</Command.Item>
    </Group>
    <Group>
      <Command.Item class="item" value={`${name} beta`}>{name} beta</Command.Item>
    </Group>
  </Command.List>
</Command.Root>
