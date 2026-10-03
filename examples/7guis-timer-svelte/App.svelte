<script lang="ts">
  let elapsed = $state(0);
  let duration = $state(5000);
  const segments = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  $effect(() => {
    const id = setInterval(() => {
      if (elapsed < duration) elapsed = Math.min(elapsed + 100, duration);
    }, 100);
    return () => clearInterval(id);
  });
</script>

<main>
  <h1>Timer</h1>
  <div class="row"><span>Elapsed time:</span><div id="gauge" class="gauge">{#each segments as i}<div class={elapsed * 10 >= (i + 1) * duration ? 'segment on' : 'segment'}></div>{/each}</div></div>
  <p id="elapsed">{(elapsed / 1000).toFixed(1)}s</p>
  <div class="row"><span>Duration:</span><button id="shorter" onclick={() => (duration = Math.max(1000, duration - 1000))}>−1s</button><span id="duration">{duration / 1000}s</span><button id="longer" onclick={() => (duration += 1000)}>+1s</button></div>
  <div class="row"><button id="reset" onclick={() => (elapsed = 0)}>Reset</button></div>
</main>
