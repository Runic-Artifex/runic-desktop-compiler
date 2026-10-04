<script setup lang="ts">
import { ref } from 'vue';
import { twMerge, twJoin } from 'tailwind-merge';
import { cn } from './utils.ts';
import { buttonVariants, badgeVariants, type ButtonVariant, type ButtonSize } from './variants.ts';

const variant = ref<ButtonVariant>('solid');
const size = ref<ButtonSize>(undefined);
const active = ref(false);
const open = ref(false);
const tone = ref<'warm' | 'cool' | null>(null);
const override = ref<ButtonVariant | ''>('');
const filter = ref<'all' | 'open'>('all');

function nextVariant() {
  variant.value = variant.value === 'solid' ? 'outline' : variant.value === 'outline' ? 'ghost' : 'solid';
}
function nextSize() {
  size.value =
    size.value === undefined ? 'sm' : size.value === 'sm' ? 'lg' : size.value === 'lg' ? 'md' : undefined;
}
function nextTone() {
  tone.value = tone.value === null ? 'warm' : tone.value === 'warm' ? 'cool' : null;
}
</script>

<template>
  <main>
    <h1 id="title" :class="twMerge('title text-base', 'text-lg')">Tailwind packs</h1>
    <div class="row">
      <button id="variant" :class="cn(buttonVariants({ variant, size }), 'w-28')" @click="nextVariant">Variant</button>
      <button id="size" :class="cn(buttonVariants({ variant: 'outline', size }), 'w-28')" @click="nextSize">Size</button>
      <button id="active" :class="cn('btn w-28 border px-4 py-2', active && 'bg-green px-6', open ? 'py-1' : 'py-3')" @click="active = !active">Active</button>
      <button id="open" :class="buttonVariants({ variant: filter === 'all' ? 'ghost' : 'outline', size: 'sm', class: 'w-28' })" @click="open = !open">Open</button>
      <button id="tone" :class="cn(buttonVariants({ variant: 'ghost', size: 'sm', class: 'px-8 rounded-none' }), 'w-28')" @click="nextTone">Tone</button>
      <button id="override" :class="cn(buttonVariants({ variant: override || variant, size: 'sm' }), 'w-28')" @click="override = override === '' ? 'ghost' : ''">Override</button>
      <button id="filter" :class="twMerge('btn w-28 border px-2 py-1', filter === 'open' && 'bg-blue text-white')" @click="filter = filter === 'all' ? 'open' : 'all'">Filter</button>
    </div>
    <div class="row">
      <span id="badge" :class="badgeVariants({ active, tone })">Badge</span>
      <span id="badge-const" :class="badgeVariants({ tone: 'cool', class: 'px-4' })">Const</span>
      <span id="group" :class="cn('group py-1', open && 'flex flex-col py-2')">Group</span>
      <span id="list" :class="cn(['item px-2', active && 'px-3'], { 'text-blue': open, 'font-bold': !open })">List</span>
    </div>
    <p><code id="v-variant">{{ cn(buttonVariants({ variant, size }), 'w-28') }}</code></p>
    <p><code id="v-badge">{{ badgeVariants({ active, tone }) }}</code></p>
    <p><code id="v-join">{{ twJoin('p-2', active && 'p-4', tone) }}</code></p>
    <p><code id="v-const">{{ twMerge('p-2 text-sm', 'p-4 font-bold', ['px-1', 'shadow-md shadow-inner']) }}</code></p>
  </main>
</template>
