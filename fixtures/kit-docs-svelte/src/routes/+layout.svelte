<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

<div class="style-vega flex min-h-svh flex-col bg-background text-foreground">
  <header class="sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background px-6">
    <a id="home" href="/" class="font-semibold">shadcn-svelte</a>
    <span class="text-sm text-muted-foreground">Docs</span>
  </header>
  <div class="flex flex-1">
    <aside id="sidebar" class="w-52 shrink-0 border-r px-4 py-6">
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
    <main class="min-w-0 flex-1">
      {@render children()}
    </main>
  </div>
</div>
