<script lang="ts">
  import { page } from '$app/state';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const Markdown = $derived(data.component);
  const doc = $derived(data.metadata);
  const index = $derived(data.nav.findIndex(item => item.href === page.url.pathname));
  const previous = $derived(index > 0 ? data.nav[index - 1] : { title: '', href: '' });
  const next = $derived(
    index >= 0 && index < data.nav.length - 1 ? data.nav[index + 1] : { title: '', href: '' },
  );
</script>

<svelte:head>
  <title>{doc.title} - shadcn-svelte</title>
</svelte:head>

<div class="flex min-h-0 flex-1">
  <div id="content" class="min-w-0 flex-1 overflow-y-auto">
    <article class="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-6 px-6 py-8">
      <div class="flex flex-col gap-2">
        <h1 id="title" class="text-3xl font-semibold tracking-tight">{doc.title}</h1>
        <p id="description" class="text-muted-foreground">{doc.description}</p>
      </div>
      <Markdown viewerData={data.viewerData} />
      <div class="flex h-16 items-center gap-2">
        {#if previous.href}
          <a id="previous" href={previous.href} class="rounded-md bg-secondary px-3 py-1.5 text-sm"
            >{previous.title}</a
          >
        {/if}
        {#if next.href}
          <a id="next" href={next.href} class="ml-auto rounded-md bg-secondary px-3 py-1.5 text-sm"
            >{next.title}</a
          >
        {/if}
      </div>
    </article>
  </div>
  {#if doc.toc.length}
    <nav
      id="toc"
      class="hidden w-52 shrink-0 flex-col gap-2 overflow-y-auto px-4 py-8 text-sm md:flex"
    >
      <p class="text-xs text-muted-foreground">On This Page</p>
      {#each doc.toc as item (item.url)}
        <a id="toc-{item.url.slice(1)}" href={item.url} class="text-[0.8rem] text-muted-foreground"
          >{item.title}</a
        >
      {/each}
    </nav>
  {/if}
</div>
