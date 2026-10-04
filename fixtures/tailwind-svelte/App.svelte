<script lang="ts">
  let count = $state(0);
  let selected = $state('one');
  let agree = $state(false);
</script>

<main class="mx-auto max-w-xl p-6 font-sans text-slate-800">
  <h1 class="mb-4 text-2xl font-semibold tracking-tight">Tailwind</h1>
  <div class="flex flex-wrap items-center gap-2">
    <button id="inc" class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2" onclick={() => count++}>Add one</button>
    <span id="count" class="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-xs">{count}</span>
  </div>
  <ul class="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 shadow-sm">
    {#each ['one', 'two', 'three'] as item (item)}
      <li>
        <button id={`pick-${item}`} class={selected === item ? 'block w-full px-4 py-2 text-left bg-slate-100 font-semibold' : 'block w-full px-4 py-2 text-left'} onclick={() => (selected = item)}>{item}</button>
      </li>
    {/each}
  </ul>
  <label class="mt-4 flex items-center gap-2 rounded-md border border-slate-200 p-2 has-checked:border-blue-600 has-checked:bg-blue-50">
    <input id="agree" type="checkbox" class="size-4" bind:checked={agree} />
    <span class="text-sm">Agree</span>
  </label>
  <p class="mt-4 w-48 truncate text-sm text-slate-500">A long line of text that does not fit the box</p>
</main>
