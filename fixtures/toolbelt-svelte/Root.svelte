<script lang="ts">
  import type { Snippet } from 'svelte';
  import { boxWith, mergeProps } from 'svelte-toolbelt';
  import { RootState } from './disclosure.svelte.ts';

  let {
    open = $bindable(false),
    onOpenChange,
    children,
    ...rest
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
    [key: string]: unknown;
  } = $props();

  const id = $props.id();
  const root = RootState.create({
    open: boxWith(
      () => open,
      v => {
        open = v;
        onOpenChange?.(v);
      },
    ),
    id: boxWith(() => 'root-' + id),
  });
  const merged = $derived(mergeProps(rest, root.props));
</script>

<div {...merged}>
  {@render children?.()}
  <p class="log">toggles {root.toggles}, panel {root.seen}</p>
</div>
