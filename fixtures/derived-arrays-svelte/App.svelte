<script lang="ts">
  // Derived values over arrays changed in place: filters, the array itself
  // (the same proxy), a sorted copy, a sum; in-place push, splice and sort.
  let items = $state([3, 1, 2]);
  const odd = $derived(items.filter((n) => n % 2 === 1));
  const same = $derived(items);
  const sorted = $derived.by(() => [...items].sort((a, b) => a - b));
  const total = $derived(items.reduce((a, b) => a + b, 0));
  let runs = 0;
  const counted = $derived.by(() => {
    runs += 1;
    return items.length;
  });
  let shown = $state('');

  function push() {
    items.push(items.length + 4);
  }
  function remove() {
    items.splice(0, 1);
  }
  function sortInPlace() {
    items.sort((a, b) => b - a);
  }
  function setFirst() {
    items[0] = items[0] + 10;
  }
  function show() {
    shown = `${counted} runs ${runs}`;
  }
</script>

<main>
  <h1 id="title">Derived arrays</h1>
  <p id="items">{items.join(',')}</p>
  <p id="odd">{odd.join(',')}</p>
  <p id="same">{same.join(',')} {same.length}</p>
  <p id="sorted">{sorted.join(',')}</p>
  <p id="total">{total}</p>
  <p id="shown">{shown}</p>
  <div class="controls">
    <button id="push" onclick={push}>Push</button>
    <button id="remove" onclick={remove}>Remove</button>
    <button id="sort" onclick={sortInPlace}>Sort</button>
    <button id="first" onclick={setFirst}>First</button>
    <button id="show" onclick={show}>Show</button>
  </div>
</main>
