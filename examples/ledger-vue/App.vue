<script setup lang="ts">
import { computed, ref } from 'vue';

interface Entry {
  label: string;
  amount: number;
  category: string;
  paid: boolean;
}

const presets: Entry[] = [
  { label: 'Coffee', amount: 3.5, category: 'food', paid: false },
  { label: 'Train ticket', amount: 12.4, category: 'travel', paid: false },
  { label: 'Notebook', amount: 7.25, category: 'office', paid: true },
  { label: 'Lunch', amount: 9.9, category: 'food', paid: false },
];

const entries = ref<Entry[]>([]);
const draft = ref('');
const added = ref(0);

const total = computed(() => entries.value.reduce((sum, e) => sum + e.amount, 0));
const unpaid = computed(() => entries.value.filter(e => !e.paid));
const largest = computed(() => entries.value.reduce((max, e) => Math.max(max, e.amount), 0));
const categories = computed(() => {
  const counts = new Map<string, number>();
  const names: string[] = [];
  for (const e of entries.value) {
    if (!counts.has(e.category)) names.push(e.category);
    counts.set(e.category, (counts.get(e.category) ?? 0) + e.amount);
  }
  names.sort();
  return names.map(name => `${name}: ${(counts.get(name) ?? 0).toFixed(2)}`).join(', ');
});

function describe(list: Entry[]): string {
  if (list.length === 0) return 'nothing';
  const labels = list.map(e => e.label);
  if (labels.length > 2) return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
  return labels.join(' and ');
}

function addPreset() {
  const preset = presets[added.value % presets.length];
  entries.value.push({ ...preset });
  added.value += 1;
}

function addDraft() {
  const label = draft.value.trim();
  if (label.length === 0) return;
  const name = label.slice(0, 1).toUpperCase() + label.slice(1);
  entries.value.push({ label: name, amount: label.length * 1.5, category: 'custom', paid: false });
  draft.value = '';
}

function payFirst() {
  const entry = entries.value.find(e => !e.paid);
  if (entry) entry.paid = true;
}

function removeLast() {
  entries.value.pop();
}
</script>

<template>
  <main>
    <h1>Ledger</h1>
    <p id="count">{{ entries.length }} entries, {{ unpaid.length }} unpaid</p>
    <p id="total">Total: {{ total.toFixed(2) }}, largest: {{ largest.toFixed(2) }}</p>
    <p id="unpaid">Unpaid: {{ describe(unpaid) }}</p>
    <p id="categories">{{ categories || 'No categories yet' }}</p>
    <div class="row">
      <input id="draft" type="text" :value="draft" @input="draft = $event.target.value" />
      <button id="add-draft" @click="addDraft" :disabled="draft.trim() === ''">Add</button>
    </div>
    <div class="row">
      <button id="add" @click="addPreset">Add preset</button>
      <button id="pay" @click="payFirst" :disabled="unpaid.length === 0">Pay first unpaid</button>
      <button id="remove" @click="removeLast" :disabled="entries.length === 0">Remove last</button>
    </div>
  </main>
</template>
