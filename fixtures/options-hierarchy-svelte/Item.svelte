<script lang="ts">
  import { getGroupCtx } from './Group.svelte';

  let { value, tone }: { value: string; tone?: 'plain' | 'loud' } = $props();

  const ctx = getGroupCtx();
  const pressed = $derived(ctx.group.includes(value));
</script>

<button
  id={value}
  class={pressed ? 'current' : ''}
  aria-pressed={ctx.group.isMulti ? String(pressed) : undefined}
  aria-checked={ctx.group.isMulti ? undefined : String(pressed)}
  data-tone={ctx.tone || tone}
  onclick={() => ctx.group.toggle(value)}
>
  {value}
</button>
