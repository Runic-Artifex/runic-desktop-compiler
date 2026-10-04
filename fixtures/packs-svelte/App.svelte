<script lang="ts">
  import clsx from 'clsx';
  import { clsx as cx } from 'clsx';
  import XIcon from '@lucide/svelte/icons/x';
  import CheckIcon from '@lucide/svelte/icons/check';
  import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import Settings2Icon from '@lucide/svelte/icons/settings-2';
  import Loader2Icon from '@lucide/svelte/icons/loader-2';

  let active = $state(false);
  let size = $state(16);
  let tone = $state<string | null>(null);
  let count = $state(0);
  let tags = $state(['one', '', 'two']);
  const label = (on: boolean) => (on ? 'label on' : 'label');
</script>

<main>
  <h1 id="title">Packs</h1>
  <div class="row">
    <button id="toggle" onclick={() => (active = !active)}><CheckIcon class={clsx('icon', active && 'on')} /> Toggle</button>
    <button id="grow" onclick={() => (size = size === 16 ? 24 : 16)}>Grow <ChevronDownIcon size={size} strokeWidth={active ? 3 : 2} data-icon="inline-end" /></button>
    <button id="tone" onclick={() => (tone = tone === null ? 'warm' : null)}>Tone</button>
    <button id="count" onclick={() => (count = count + 1)}>Count</button>
    <button id="tags" onclick={() => (tags = active ? [] : [...tags, 'three'])}>Tags</button>
  </div>
  <div
    id="box"
    class={clsx(
      'box',
      active && 'active',
      { muted: !active, 'is-on': active, 2: count > 1 },
      tone,
      ['pad', active ? 'wide' : null, [count && 'counted', false]],
      count,
      tags,
    )}
  >
    Box
  </div>
  <p id="spaced" class={cx('  spaced ', active ? 'x' : '', tone ?? 'plain')}>{cx(label(active), tone || 'none', count)}</p>
  <div class="row">
    <XIcon />
    <AlertCircleIcon class="warn" aria-hidden="true" />
    <Settings2Icon color={active ? '#a0452a' : ''} absoluteStrokeWidth={true} size={size} role="img" aria-label="Settings" />
    <Loader2Icon class={['spin', active && 'busy']} id="loader" />
  </div>
</main>
