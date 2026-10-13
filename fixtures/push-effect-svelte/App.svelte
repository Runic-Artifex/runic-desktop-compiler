<script lang="ts">
  // An effect pushing to a $state array it does not otherwise read: push
  // reads the length through the proxy, so the effect depends on it.
  let log = $state<string[]>([]);
  let count = $state(0);
  let errors = $state('');
  $effect(() => {
    if (log.length < 50) log.push('run ' + count);
  });
</script>

<main>
  <h1 id="title">Push in an effect</h1>
  <p id="log">{log.length} {log.slice(0, 3).join(', ')}</p>
  <p id="errors">{errors}</p>
  <button id="bump" onclick={() => (count += 1)}>Bump</button>
</main>
