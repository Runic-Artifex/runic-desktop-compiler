<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  let guard = $state(false);
  let navigations = $state(0);

  beforeNavigate(navigation => {
    console.log('before', navigation.type, navigation.to?.route.id ?? 'none');
    if (guard) navigation.cancel();
  });

  afterNavigate(navigation => {
    navigations++;
    console.log(
      'after',
      navigation.type,
      navigation.from?.url?.pathname ?? 'none',
      navigation.to?.url?.pathname ?? 'none',
    );
  });
</script>

<header>
  <nav>
    <a id="nav-home" href="/">Home</a>
    <a id="nav-items" href="/items">Items</a>
    <a id="nav-item7" href="/items/7">Item 7</a>
    <a id="nav-settings" href="/settings">Settings</a>
    <a id="nav-old" href="/old">Old</a>
  </nav>
  <div class="row">
    <label><input id="guard" type="checkbox" bind:checked={guard} /> Guard</label>
    <button id="goto-item3" onclick={() => goto('/items/3?tab=notes')}>Item 3</button>
    <button id="goto-replace" onclick={() => goto('/items/4', { replaceState: true })}
      >Replace</button
    >
    <button id="goto-deep" onclick={() => goto('/items/5#details')}>Deep</button>
  </div>
</header>
<p id="status">
  {data.site} · {page.url.pathname}{page.url.search} · {page.route.id} · {page.status} · {navigations}
</p>
<main>
  {@render children()}
</main>
