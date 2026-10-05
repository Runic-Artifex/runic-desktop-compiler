<script lang="ts">
  // Capture listeners of attribute bags (Svelte's `on<event>capture`, M6
  // overlays: bits-ui's dismissible layer tracks focus inside its content
  // with `onfocuscapture` and `onblurcapture`): they run from the root down
  // to the target, before the target's and the bubbling listeners; focus
  // events, which do not bubble, reach ancestors' capture listeners.
  let log = $state('');
  const note = (s: string) => () => {
    log += s;
  };
  const outer = {
    onclickcapture: note('C'),
    onclick: note('b'),
    onfocuscapture: note('F'),
    onblurcapture: note('B'),
  };
  const inner = {
    onclickcapture: (e: MouseEvent) => {
      log += 'c';
      if (stop) e.stopPropagation();
    },
    onkeydowncapture: (e: KeyboardEvent) => {
      log += `k${e.key}`;
    },
  };
  let stop = $state(false);
</script>

<div id="app">
  <div id="outer" {...outer}>
    <p id="inner" {...inner}>
      <button id="first" onclick={() => (log += '1')} onfocus={() => (log += 'f')}>first</button>
      <button id="second" onclick={() => (log += '2')} onblur={() => (log += 'x')}>second</button>
    </p>
  </div>
  <button id="stop" onclick={() => (stop = !stop)}>stop {stop}</button>
  <button id="clear" onclick={() => (log = '')}>clear</button>
  <p id="log">{log}</p>
</div>
