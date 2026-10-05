<script lang="ts">
  // bits-ui's Progress compiled from its published source, through
  // shadcn-svelte's progress wrapper and its demo (src/lib/registry:
  // unmodified upstream sources, see vendor.json): the demo moves from 13 to
  // 66 after 500 ms; a second bar's value and max change from outside,
  // including an indeterminate (null) value.
  import ProgressDemo from '$lib/registry/examples/progress-demo.svelte';
  import { Progress } from '$lib/registry/ui/progress/index.js';

  let value = $state<number | null>(25);
  let max = $state(100);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="demo"><ProgressDemo /></div>
  <div id="bar"><Progress {value} {max} class="w-[300px]" /></div>
  <div class="flex gap-2">
    <button id="more" class="rounded-md border px-3 py-1 text-sm" onclick={() => (value = (value ?? 0) + 25)}>
      More
    </button>
    <button id="unknown" class="rounded-md border px-3 py-1 text-sm" onclick={() => (value = null)}>
      Unknown
    </button>
    <button id="max" class="rounded-md border px-3 py-1 text-sm" onclick={() => (max = max === 100 ? 200 : 100)}>
      Max
    </button>
  </div>
</div>
