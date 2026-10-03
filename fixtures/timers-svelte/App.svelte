<script lang="ts">
  let elapsed = $state(0);
  let duration = $state(1000);
  let running = $state(false);
  let id: number | undefined;
  let frames = $state(0);
  let frameTimes = $state('');
  let log = $state('');
  function start() {
    if (running) return;
    running = true;
    id = setInterval(() => {
      elapsed = Math.min(elapsed + 100, duration);
      if (elapsed >= duration) stop();
    }, 100);
  }
  function stop() {
    clearInterval(id);
    id = undefined;
    running = false;
  }
  function animate() {
    requestAnimationFrame((t) => {
      frames += 1;
      frameTimes = frameTimes + ' ' + t;
      if (frames % 4 !== 0) animate();
    });
  }
  function later() {
    log = 'scheduled';
    setTimeout(() => (log = log + ' 250'), 250);
    setTimeout(() => {
      log = log + ' 0';
      setTimeout(() => (log = log + ' nested-0'), 0);
    }, 0);
    setTimeout(() => (log = log + ' 100'), 100);
    const cancelled = setTimeout(() => (log = log + ' cancelled'), 50);
    clearTimeout(cancelled);
  }
  function clocks() {
    log = `date ${Date.now() - 1767225600000} perf ${performance.now()}`;
  }
</script>
<main><h1 id="title">Timers</h1>
<p id="elapsed">{elapsed} / {duration} {running ? 'running' : 'stopped'}</p>
<p id="frames">{frames}:{frameTimes}</p>
<p id="log">{log}</p>
<div class="controls"><button id="start" onclick={start}>Start</button><button id="stop" onclick={stop}>Stop</button><button id="reset" onclick={() => (elapsed = 0)}>Reset</button><button id="longer" onclick={() => (duration += 500)}>Longer</button><button id="animate" onclick={animate}>Animate</button><button id="later" onclick={later}>Later</button><button id="clocks" onclick={clocks}>Clocks</button></div>
</main>
