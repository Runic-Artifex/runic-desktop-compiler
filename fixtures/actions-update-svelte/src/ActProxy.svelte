<script lang="ts">
  import { counts, deep } from './state.svelte.ts';
  type Deep = { n: number; inner: { m: number } };
  // The value is the proxy itself: its fields are read deeply.
  function act(node: HTMLElement, v: Deep) {
    let updates = 0;
    node.setAttribute('data-init', `${v.n} ${v.inner.m}`);
    return {
      update(next: Deep) {
        updates++;
        node.setAttribute('data-update', `${updates}: ${next.n} ${next.inner.m}`);
      },
      destroy() {
        counts.destroyed++;
      },
    };
  }
</script>

<p id="proxy" use:act={deep}>proxy</p>
