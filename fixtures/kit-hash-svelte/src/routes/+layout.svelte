<script lang="ts">
  // An editor-like shell: one layout around the pages, kept across
  // navigations (its counter survives them).
  import '../app.css';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
  let opened = $state(0);
</script>

<header>
  <nav>
    <a id="nav-home" href="#/">Home</a>
    <a id="nav-about" href="#/about">About</a>
    <a id="nav-missing" href="#/missing">Missing</a>
  </nav>
  <button id="open" onclick={() => opened++}>Opened {opened}</button>
</header>
<main>
  {@render children()}
</main>
