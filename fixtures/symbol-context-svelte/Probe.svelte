<script lang="ts">
  import { getOther, hasTone, hasUnset } from './context.ts';

  let { id }: { id: string } = $props();

  const tone = hasTone();
  const other = getOther() ?? 'none';
  const unset = hasUnset();
</script>

<p class="probe" {id}>{tone ? 'tone' : 'no tone'} · other: {other} · unset: {unset}</p>
