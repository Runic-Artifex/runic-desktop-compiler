<script lang="ts">
  import { held } from './state.svelte.ts';
  type Held = { k: number };
  // A plain object holding a proxy at its top level: the proxy is read deeply.
  function act(node: HTMLElement, v: { held: Held }) {
    let updates = 0;
    node.setAttribute('data-init', `${v.held.k}`);
    return {
      update(next: { held: Held }) {
        updates++;
        node.setAttribute('data-update', `${updates}: ${next.held.k}`);
      },
    };
  }
</script>

<p id="holds" use:act={{ held }}>holds</p>
