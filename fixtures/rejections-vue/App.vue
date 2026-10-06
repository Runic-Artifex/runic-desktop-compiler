<script setup lang="ts">
import { ref, watch } from 'vue';
import { chained, failLater, handledInMicrotask, rejectNow, timer } from './rejections.ts';

const count = ref(0);

watch(
  count,
  c => {
    console.log('count ' + c);
  },
  { immediate: true },
);

// Vue catches a promise a listener returns and logs it from its own code
// (callWithAsyncErrorHandling: tests/rejections.test.mjs); this listener
// leaves failLater's promise unhandled instead.
function asyncFailure() {
  count.value++;
  failLater();
}

function stateAndReject() {
  count.value++;
  Promise.reject(new Error('after a write'));
}
</script>

<template>
  <main>
    <p id="count">{{ count }}</p>
    <div class="row">
      <button id="reject" @click="rejectNow">Reject</button>
      <button id="handled" @click="handledInMicrotask">Handled</button>
      <button id="chained" @click="chained">Chained</button>
      <button id="async" @click="asyncFailure">Async</button>
      <button id="state" @click="stateAndReject">State</button>
      <button id="timer" @click="timer">Timer</button>
    </div>
  </main>
</template>
