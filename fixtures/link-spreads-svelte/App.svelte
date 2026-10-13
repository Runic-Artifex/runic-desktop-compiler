<script lang="ts">
  // Links whose href arrives through spread attributes (shadcn-svelte's
  // breadcrumb), each value known at build time: fragments naming no
  // element, the document top (# and #top), a link without an href, and an
  // attribute after a spread overriding the spread's open href.
  import Link from './Link.svelte';

  const ui = $state({ far: false, hash: '', changes: 0, open: '#open' as string });
  const bag = { href: '#beta', title: 'from a bag' };
</script>

<svelte:window
  onhashchange={() => {
    ui.hash = location.hash;
    ui.changes += 1;
  }}
/>

<main>
  <h1>Links through spreads</h1>
  <p id="hash">hash {ui.hash === '' ? '(none)' : ui.hash}, {ui.changes} changes</p>
  <div class="controls">
    <button id="far" onclick={() => (ui.far = !ui.far)}>far {ui.far}</button>
  </div>
  <nav class="crumbs">
    <Link id="to-alpha" href="#alpha">Alpha</Link>
    <Link id="to-top" href="#">Top</Link>
    <Link id="to-choice" href={ui.far ? '#far-away' : '#nearby'}>Near or far</Link>
    <Link id="no-href">No href</Link>
    <a id="to-bag" {...bag}>Beta</a>
    <a id="to-override" {...{ href: ui.open }} href="#gamma">Gamma</a>
  </nav>
  <div class="spacer">Further down: links back to the top</div>
  <nav class="crumbs">
    <Link id="to-top-below" href="#">Back to the top</Link>
    <Link id="to-top-named" class="named" href="#top">Top by name</Link>
  </nav>
</main>
