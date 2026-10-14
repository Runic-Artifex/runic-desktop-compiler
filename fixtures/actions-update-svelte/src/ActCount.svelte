<script lang="ts">
  let { count }: { count: number } = $props();
  // A primitive value: update runs when it changes (safe_not_equal), not
  // when the same value is set again. It runs before the component's own
  // bindings update (Svelte updates a template's text and attributes in one
  // render effect created after the action's), so it reads the old text.
  function act(node: HTMLElement, v: number) {
    let updates = 0;
    node.setAttribute('data-init', `${v}`);
    return {
      update(next: number) {
        updates++;
        node.setAttribute('data-update', `${updates}: ${next} (${node.textContent})`);
      },
    };
  }
</script>

<p id="counted" use:act={count}>counted {count}</p>
