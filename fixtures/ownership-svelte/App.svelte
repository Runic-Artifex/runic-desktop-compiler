<script lang="ts">
  interface Item { id: number; name: string }
  let items = $state<Item[]>([]);
  let next = $state(1);
  let log = $state('');
  let selected = $state<Item | null>(null);
  let tags = $state(new Map<number, string>());
  let tagCount = $state(0);
  function add() {
    const it: Item = { id: next, name: `Item ${next}` };
    items.push(it);
    it.name = `Item ${next} renamed`;
    log = `includes=${items.includes(it)} last-is-raw=${items[items.length - 1] === it} index=${items.indexOf(it)}`;
    next += 1;
  }
  function pick() {
    const first = items.at(0);
    selected = first ?? null;
    log = `selected-is-first=${selected === (items.at(0) ?? null)} index=${first ? items.indexOf(first) : -2}`;
  }
  function copy() {
    const first = items.at(0);
    if (!first) return;
    const raw = { ...first };
    selected = raw;
    log = `copy-index=${items.indexOf(raw)} copy-is-selected=${selected === raw}`;
  }
  function rename() {
    if (selected) selected.name = selected.name + '!';
  }
  function tag() {
    tags.set(next, 'x');
    tagCount += 1;
  }
</script>
<main><h1 id="title">Ownership</h1>
<p id="log">{log}</p>
<ul>{#each items as item (item.id)}<li id={`item-${item.id}`}>{item.name}</li>{/each}</ul>
<p id="selected">{selected ? selected.name : 'none'}</p>
<p id="tag-count">{tagCount}</p>
<div class="controls"><button id="add" onclick={add}>Add</button><button id="pick" onclick={pick}>Pick</button><button id="copy" onclick={copy}>Copy</button><button id="rename" onclick={rename}>Rename</button><button id="tag" onclick={tag}>Tag</button></div>
</main>
