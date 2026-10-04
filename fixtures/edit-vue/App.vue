<script setup lang="ts">
// TodoMVC's edit mode in Vue: Enter saves and leaves edit mode, which
// removes the focused input during the patch (Chromium blurs it then);
// clicking elsewhere saves through blur; Alt+ArrowUp moves the edited item.
import { ref } from 'vue';
type Item = { id: number; text: string };
const items = ref<Item[]>([
  { id: 1, text: 'Milk' },
  { id: 2, text: 'Bread' },
  { id: 3, text: 'Eggs' },
]);
const editing = ref(0);
const log = ref<string[]>([]);

function save(item: Item, text: string, why: string) {
  log.value.push(`${why} ${item.id} ${editing.value}`);
  if (editing.value !== item.id) return;
  item.text = text.trim();
  editing.value = 0;
}

function key(e: KeyboardEvent, item: Item) {
  const value = (e.target as HTMLInputElement).value;
  if (e.key === 'Enter') save(item, value, 'enter');
  if (e.key === 'ArrowUp' && e.altKey) {
    const list = items.value;
    const i = list.indexOf(item);
    if (i > 0) items.value = [...list.slice(0, i - 1), item, list[i - 1], ...list.slice(i + 1)];
    log.value.push(`up ${item.id}`);
  }
}
</script>

<template>
  <main>
    <button id="other">Other</button>
    <ul>
      <li v-for="item in items" :key="item.id">
        <input
          v-if="editing === item.id"
          :id="'edit-' + item.id"
          type="text"
          :value="item.text"
          @blur="save(item, ($event.target as HTMLInputElement).value, 'blur')"
          @keydown="key($event, item)"
        />
        <span v-else :id="'label-' + item.id" @dblclick="editing = item.id">{{ item.text }}</span>
      </li>
    </ul>
    <p id="log">{{ log.join(', ') }}</p>
  </main>
</template>
