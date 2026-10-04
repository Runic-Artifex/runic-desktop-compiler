<script lang="ts">
  import type { Snippet } from 'svelte';
  import { boxWith, mergeProps } from 'svelte-toolbelt';
  import { PanelState } from './disclosure.svelte.ts';

  let {
    ref = $bindable(null),
    children,
    ...rest
  }: { ref?: HTMLElement | null; children?: Snippet; [key: string]: unknown } = $props();
  const id = $props.id();
  const panel = PanelState.create(
    boxWith(() => 'panel-' + id),
    boxWith(
      () => ref,
      v => (ref = v),
    ),
  );
  const merged = $derived(mergeProps(rest, panel.props));
</script>

<div {...merged}>{@render children?.()}</div>
