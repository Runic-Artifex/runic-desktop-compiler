<script lang="ts">
  import type { Snippet } from 'svelte';
  import { mergeProps } from 'svelte-toolbelt';
  import { TriggerState } from './disclosure.svelte.ts';

  let { children, ...rest }: { children?: Snippet; [key: string]: unknown } = $props();
  const trigger = TriggerState.create();
  const merged = $derived(mergeProps(rest, trigger.props));
</script>

<button {...merged}>{@render children?.()}</button>
