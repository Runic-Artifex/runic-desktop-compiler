<script setup lang="ts">
import { ref, computed } from 'vue';
import { parseDate } from './dates.ts';

const kind = ref('one-way');
const start = ref('27.03.2014');
const back = ref('27.03.2014');
const message = ref('');
const isReturn = computed(() => kind.value === 'return');
const startTime = computed(() => parseDate(start.value));
const backTime = computed(() => parseDate(back.value));
const bookable = computed(
  () =>
    startTime.value !== null &&
    (!isReturn.value || (backTime.value !== null && backTime.value >= startTime.value)),
);

function book() {
  message.value = isReturn.value
    ? `You have booked a return flight on ${start.value}, returning on ${back.value}.`
    : `You have booked a one-way flight on ${start.value}.`;
}
</script>

<template>
  <main>
    <h1>Flight Booker</h1>
    <select id="kind" aria-label="Flight" v-model="kind">
      <option value="one-way">one-way flight</option>
      <option value="return">return flight</option>
    </select>
    <input id="start" type="text" aria-label="Start date" :class="{ invalid: startTime === null }" :value="start" @input="start = $event.target.value" />
    <input id="return" type="text" aria-label="Return date" :class="{ invalid: isReturn && backTime === null }" :disabled="!isReturn" :value="back" @input="back = $event.target.value" />
    <button id="book" :disabled="!bookable" @click="book">Book</button>
    <p id="message">{{ message }}</p>
  </main>
</template>
