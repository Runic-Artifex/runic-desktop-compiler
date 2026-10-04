<script lang="ts">
  // Script-controlled radio buttons whose states can conflict: checking one
  // unchecks the rest of its group, so the later write wins.
  let a = $state(true);
  let b = $state(true);
  let c = $state(false);
  let log = $state<string[]>([]);
</script>

<main>
  <div class="row">
    <label id="a-label"><input id="a" type="radio" name="g" checked={a} onchange={() => log.push('a')} /> A</label>
    <label id="b-label"><input id="b" type="radio" name="g" checked={b} onchange={() => log.push('b')} /> B</label>
    <label id="c-label"><input id="c" type="radio" name="g" checked={c} onchange={() => log.push('c')} /> C</label>
  </div>
  <div class="row">
    <button id="toggle-a" onclick={() => (a = !a)}>A</button>
    <button id="toggle-c" onclick={() => (c = !c)}>C</button>
    <button id="all" onclick={() => { a = true; b = true; c = true; }}>All</button>
  </div>
  <p id="state">{a} {b} {c}</p>
  <p id="log">{log.join(' ')}</p>
</main>
