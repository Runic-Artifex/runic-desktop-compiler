<script lang="ts">
  // TodoMVC's edit mode: Enter saves and leaves edit mode, which removes the
  // focused input (Chromium blurs it during the DOM update: the blur handler
  // runs and sees edit mode already left); clicking elsewhere saves through
  // blur; Alt+ArrowUp moves the edited item while editing (a keyed move
  // detaches whichever block the framework moves).
  type Item = { id: number; text: string };
  let items = $state<Item[]>([
    { id: 1, text: 'Milk' },
    { id: 2, text: 'Bread' },
    { id: 3, text: 'Eggs' },
  ]);
  let editing = $state(0);
  let log = $state<string[]>([]);

  function save(item: Item, text: string, why: string) {
    log.push(`${why} ${item.id} ${editing}`);
    if (editing !== item.id) return;
    item.text = text.trim();
    editing = 0;
  }

  function key(e: KeyboardEvent, item: Item, value: string) {
    if (e.key === 'Enter') save(item, value, 'enter');
    if (e.key === 'ArrowUp' && e.altKey) {
      const i = items.indexOf(item);
      if (i > 0) items = [...items.slice(0, i - 1), item, items[i - 1], ...items.slice(i + 1)];
      log.push(`up ${item.id}`);
    }
  }
</script>

<main>
  <button id="other">Other</button>
  <ul>
    {#each items as item (item.id)}
      <li>
        {#if editing === item.id}
          <input
            id={'edit-' + item.id}
            type="text"
            value={item.text}
            onblur={(e) => save(item, (e.target as HTMLInputElement).value, 'blur')}
            onkeydown={(e) => key(e, item, (e.target as HTMLInputElement).value)}
          />
        {:else}
          <span id={'label-' + item.id} ondblclick={() => (editing = item.id)}>{item.text}</span>
        {/if}
      </li>
    {/each}
  </ul>
  <p id="log">{log.join(', ')}</p>
</main>
