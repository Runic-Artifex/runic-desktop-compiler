<script lang="ts">
  interface Props { id: number; label: string; first: boolean; onremove: (id: number) => void; onup: (id: number) => void }
  let { id, label, first, onremove, onup }: Props = $props();
  let clicks = $state(0);
</script>
<li id={`row-${id}`}><span id={`label-${id}`}>{label} ({clicks})</span><button id={`count-${id}`} onclick={() => clicks += 1}>+1</button><button id={`up-${id}`} disabled={first} onclick={() => onup(id)}>Up</button><button id={`remove-${id}`} onclick={() => onremove(id)}>Remove</button></li>
