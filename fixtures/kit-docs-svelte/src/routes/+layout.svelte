<script lang="ts">
  // The docs layout: a header, the components sidebar (server data) and the
  // page, which scrolls in its own pane (Blitz keeps no box in view while the
  // document scrolls: docs/BLITZ-GAPS.md).
  import '../app.css';
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

<div class="style-vega flex h-screen flex-col bg-background text-foreground">
  <header class="flex h-14 shrink-0 items-center gap-4 border-b px-6">
    <a id="home" href="/" class="font-semibold">shadcn-svelte</a>
    <span class="text-sm text-muted-foreground">Docs</span>
  </header>
  <div class="flex min-h-0 flex-1">
    <aside
      id="sidebar"
      class="w-32 shrink-0 overflow-y-auto border-r px-3 py-6 md:w-52 md:px-4"
    >
      <p class="mb-2 text-xs font-medium text-muted-foreground">Components</p>
      <ul class="flex flex-col gap-1">
        {#each data.nav as item (item.href)}
          <li>
            <a
              id="nav-{item.title.toLowerCase()}"
              href={item.href}
              data-active={item.href === page.url.pathname}
              class="block rounded-md px-2 py-1 text-sm data-[active=true]:bg-muted data-[active=true]:font-medium"
              >{item.title}</a
            >
          </li>
        {/each}
      </ul>
    </aside>
    <main class="flex min-h-0 min-w-0 flex-1 flex-col">
      {@render children()}
    </main>
  </div>
</div>
