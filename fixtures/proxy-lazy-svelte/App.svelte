<script lang="ts">
  // A proxy reads a property of its target when it first reads it, and from
  // then on its own value: a raw write before that read is visible, one
  // after it is not.
  type Item = { name: string };
  const raw: Item = { name: 'first' };
  let held = $state(raw);
  let items = $state<Item[]>([]);
  let tick = $state(0);
  let last: Item | null = null;

  function rawWrite() {
    raw.name = raw.name + '*';
    tick += 1;
  }
  function touch() {
    items.push({ name: `touch ${items.length}` });
  }
  function pushThenWrite() {
    const it: Item = { name: 'new' };
    items.push(it);
    it.name = 'renamed';
    last = it;
  }
  function laterWrite() {
    if (last) last.name = last.name + '!';
    tick += 1;
  }
</script>

<main>
  <h1 id="title">Lazy proxies</h1>
  <p id="held">{held.name}</p>
  <p id="items">{items.map((i) => i.name).join(',')}</p>
  <p id="tick">{tick}</p>
  <div class="controls">
    <button id="raw-write" onclick={rawWrite}>Raw write</button>
    <button id="touch" onclick={touch}>Touch</button>
    <button id="push-write" onclick={pushThenWrite}>Push, write</button>
    <button id="later-write" onclick={laterWrite}>Later write</button>
  </div>
</main>
