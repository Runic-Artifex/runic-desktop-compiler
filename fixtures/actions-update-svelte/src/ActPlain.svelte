<script lang="ts">
  import { far } from './state.svelte.ts';
  type Held = { k: number };
  const wrap = { held: far };
  // A proxy inside a plain object inside the value: not read.
  function act(node: HTMLElement, v: { wrap: { held: Held } }) {
    let updates = 0;
    node.setAttribute('data-init', `${v.wrap.held.k}`);
    return {
      update(next: { wrap: { held: Held } }) {
        updates++;
        node.setAttribute('data-update', `${updates}: ${next.wrap.held.k}`);
      },
    };
  }
</script>

<p id="plain" use:act={{ wrap }}>plain</p>
