<script lang="ts">
  // shadcn-svelte's CommandGroup (ui/command/command-group.svelte) without
  // its Tailwind classes: a group without a value or heading takes one from
  // bits-ui's global id counter.
  import { Command as CommandPrimitive, useId } from 'bits-ui';

  let {
    ref = $bindable(null),
    children,
    heading,
    value,
    ...restProps
  }: CommandPrimitive.GroupProps & {
    heading?: string;
  } = $props();
</script>

<CommandPrimitive.Group
  bind:ref
  class="group"
  value={value ?? heading ?? `----${useId()}`}
  {...restProps}
>
  {#if heading}
    <CommandPrimitive.GroupHeading class="heading">{heading}</CommandPrimitive.GroupHeading>
  {/if}
  <CommandPrimitive.GroupItems {children} />
</CommandPrimitive.Group>
