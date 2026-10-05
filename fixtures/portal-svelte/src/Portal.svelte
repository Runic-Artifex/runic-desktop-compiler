<script lang="ts">
  // bits-ui 2.19.2's utilities/portal/portal.svelte with its target fixed to
  // the body: the content is mounted imperatively as the body's last child
  // from a runed watch, with this component's contexts, and unmounted when
  // the portal is disabled or destroyed; disabled, it renders in place.
  // bits-ui: MIT License, Copyright (c) 2023 Hunter Johnston.
  import { getAllContexts, mount, unmount, type Snippet } from 'svelte';
  import { watch } from 'runed';
  import PortalConsumer from './PortalConsumer.svelte';

  let { children, disabled = false }: { children?: Snippet; disabled?: boolean } = $props();

  const context = getAllContexts();

  let target = $derived(getTarget());

  function getTarget() {
    if (disabled) return null;
    return document.querySelector('body');
  }

  let instance: ReturnType<typeof mount> | null;

  function unmountInstance() {
    if (instance) {
      unmount(instance);
      instance = null;
    }
  }

  watch([() => target, () => disabled], ([target, disabled]) => {
    if (!target || disabled) {
      unmountInstance();
      return;
    }
    instance = mount(PortalConsumer, {
      target: target,
      props: { children },
      context,
    });

    return () => {
      unmountInstance();
    };
  });
</script>

{#if disabled}
  {@render children?.()}
{/if}
