<script lang="ts">
  let { count }: { count: number } = $props();
  // A primitive value: update runs when it changes (safe_not_equal), not
  // when the same value is set again.
  function act(node: HTMLElement, v: number) {
    let updates = 0;
    node.setAttribute('data-init', `${v}`);
    return {
      update(next: number) {
        updates++;
        node.setAttribute('data-update', `${updates}: ${next}`);
      },
    };
  }
</script>

<p id="counted" use:act={count}>counted</p>
