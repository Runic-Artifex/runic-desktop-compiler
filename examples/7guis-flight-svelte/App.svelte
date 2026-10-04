<script lang="ts">
  import { parseDate } from './dates.ts';

  let kind = $state('one-way');
  let start = $state('27.03.2014');
  let back = $state('27.03.2014');
  let message = $state('');
  let isReturn = $derived(kind === 'return');
  let startTime = $derived(parseDate(start));
  let backTime = $derived(parseDate(back));
  let bookable = $derived(
    startTime !== null && (!isReturn || (backTime !== null && backTime >= startTime)),
  );

  function book() {
    message = isReturn
      ? `You have booked a return flight on ${start}, returning on ${back}.`
      : `You have booked a one-way flight on ${start}.`;
  }
</script>

<main>
  <h1>Flight Booker</h1>
  <select id="kind" aria-label="Flight" bind:value={kind}>
    <option value="one-way">one-way flight</option>
    <option value="return">return flight</option>
  </select>
  <input id="start" type="text" aria-label="Start date" class:invalid={startTime === null} bind:value={start} />
  <input id="return" type="text" aria-label="Return date" class:invalid={isReturn && backTime === null} disabled={!isReturn} bind:value={back} />
  <button id="book" disabled={!bookable} onclick={book}>Book</button>
  <p id="message">{message}</p>
</main>
