<script lang="ts">
  import { onMount } from 'svelte';
  import { parseRoute, shuffle } from './lib';

  // A hash router: the route follows location.hash through popstate and
  // hashchange; a filter lives in the query (pushState, replaceState).
  let hash = $state(location.hash);
  let where = $state(location.pathname + location.search);
  let length = $state(history.length);
  let events = $state<string[]>([]);
  const route = $derived(parseRoute(hash));

  function sync(kind: string) {
    hash = location.hash;
    where = location.pathname + location.search;
    length = history.length;
    events.push(`${kind} ${location.hash}`);
  }
  function go(to: string) {
    location.hash = to;
    sync('go');
  }
  function filter(q: string) {
    history.pushState(null, '', `?q=${q}${location.hash}`);
    sync('push');
  }
  function unfilter() {
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    sync('replace');
  }

  // Clipboard: copy the draft, paste into the view.
  let draft = $state('Grüße 😀');
  let pasted = $state('');
  let status = $state('idle');
  async function copy() {
    status = 'copying';
    await navigator.clipboard.writeText(draft);
    status = 'copied';
  }
  async function paste() {
    status = 'pasting';
    const text = await navigator.clipboard.readText();
    pasted = text;
    status = 'pasted';
  }

  // Console lines at every level.
  let logged = $state(0);
  function log() {
    logged++;
    console.log('clicked', logged, true, null, undefined);
    console.info(`info ${logged}`);
    console.warn('values', -0, 1e21, 0.1 + 0.2, NaN, -Infinity);
    console.error('error', logged > 1);
    console.debug('debug', 'a b', '');
  }

  // Randomness: a shuffled deck, UUIDs and a die.
  let deck = $state(['A', 'B', 'C', 'D', 'E', 'F']);
  let ids = $state<string[]>([]);
  let roll = $state(0);
  function reshuffle() {
    deck = shuffle(deck);
  }
  function newId() {
    ids.push(crypto.randomUUID());
  }
  function dice() {
    roll = Math.floor(Math.random() * 6) + 1;
  }

  onMount(() => {
    console.log('mounted at', location.pathname + location.search + location.hash);
    // Start at the home route (replaces the entry while the document loads).
    if (location.hash === '') go('#/');
  });
</script>

<svelte:window onpopstate={() => sync('popstate')} onhashchange={() => sync('hashchange')} />

<main>
  <nav class="row">
    <button id="nav-home" onclick={() => go('#/')}>Home</button>
    <button id="nav-items" onclick={() => go('#/items')}>Items</button>
    <button id="nav-item" onclick={() => go('#/items/3')}>Item 3</button>
    <button id="nav-about" onclick={() => go('/about')}>About</button>
    <button id="nav-same" onclick={() => go(location.hash)}>Same</button>
  </nav>
  <div class="row">
    <button id="filter" onclick={() => filter('red')}>Filter</button>
    <button id="unfilter" onclick={unfilter}>Unfilter</button>
    <button id="back" onclick={() => history.back()}>Back</button>
    <button id="forward" onclick={() => history.forward()}>Forward</button>
    <button id="go-2" onclick={() => history.go(-2)}>Go -2</button>
  </div>
  <section id="view">
    {#if route.name === 'home'}<h2>Home</h2>
    {:else if route.name === 'items'}<h2>Items</h2>
    {:else if route.name === 'item'}<h2>Item {route.id}</h2>
    {:else if route.name === 'about'}<h2>About</h2>
    {:else}<h2>Not found</h2>{/if}
  </section>
  <p id="location">{where} {hash} ({length})</p>
  <p id="events">{events.length}: {events.slice(-3).join(", ")}</p>

  <div class="row">
    <input id="draft" type="text" aria-label="Draft" bind:value={draft} />
    <button id="copy" onclick={copy}>Copy</button>
    <button id="paste" onclick={paste}>Paste</button>
  </div>
  <p id="clipboard">{status}: {pasted}</p>

  <div class="row">
    <button id="log" onclick={log}>Log</button>
    <span id="logged">{logged}</span>
  </div>

  <div class="row">
    <button id="shuffle" onclick={reshuffle}>Shuffle</button>
    <button id="uuid" onclick={newId}>UUID</button>
    <button id="dice" onclick={dice}>Roll</button>
  </div>
  <p id="deck">{deck.join(' ')} · {roll}</p>
  <ul id="ids">
    {#each ids as id}<li>{id}</li>{/each}
  </ul>
</main>
