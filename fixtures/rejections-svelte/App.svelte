<script lang="ts">
  import { chained, failLater, handledInMicrotask, rejectNow, timer } from './rejections.ts';

  let count = $state(0);

  $effect(() => {
    console.log('count ' + count);
  });

  async function asyncFailure() {
    count++;
    await failLater();
  }

  function stateAndReject() {
    count++;
    Promise.reject(new Error('after a write'));
  }
</script>

<main>
  <p id="count">{count}</p>
  <div class="row">
    <button id="reject" onclick={rejectNow}>Reject</button>
    <button id="handled" onclick={handledInMicrotask}>Handled</button>
    <button id="chained" onclick={chained}>Chained</button>
    <button id="async" onclick={asyncFailure}>Async</button>
    <button id="state" onclick={stateAndReject}>State</button>
    <button id="timer" onclick={timer}>Timer</button>
  </div>
</main>
