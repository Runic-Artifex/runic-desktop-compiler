<script setup lang="ts">
import { ref } from 'vue';
import clsx from 'clsx';
import { clsx as cx } from 'clsx';

const active = ref(false);
const size = ref(16);
const tone = ref<string | null>(null);
const count = ref(0);
const tags = ref(['one', '', 'two']);
const label = (on: boolean) => (on ? 'label on' : 'label');
const nextTone = (t: string | null): string | null => (t === null ? 'warm' : null);
function retag() {
  tags.value = active.value ? [] : [...tags.value, 'three'];
}
</script>

<template>
  <main>
    <h1 id="title">Packs</h1>
    <div class="row">
      <button id="toggle" @click="active = !active">Toggle</button>
      <button id="grow" :class="cx(size === 24 && 'grown')" @click="size = size === 16 ? 24 : 16">Grow</button>
      <button id="tone" @click="tone = nextTone(tone)">Tone</button>
      <button id="count" @click="count = count + 1">Count</button>
      <button id="tags" @click="retag">Tags</button>
    </div>
    <div
      id="box"
      :class="clsx(
        'box',
        active && 'active',
        { muted: !active, 'is-on': active, 2: count > 1 },
        tone,
        ['pad', active ? 'wide' : null, [count && 'counted', false]],
        count,
        tags,
      )"
    >
      Box
    </div>
    <p id="spaced" :class="cx('  spaced ', active ? 'x' : '', tone ?? 'plain')">
      {{ cx(label(active), tone || 'none', count) }}
    </p>
  </main>
</template>
