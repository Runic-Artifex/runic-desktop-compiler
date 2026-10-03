<script>
  let count = $state(0);
</script>

<main>
  <h1>Counter</h1>
  <div class="row">
    <input id="value" type="text" readonly value={count} />
    <button id="count" onclick={() => count++}>Count</button>
  </div>
</main>
