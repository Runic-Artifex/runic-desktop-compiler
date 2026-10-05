<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>shadcn-svelte docs</title>
</svelte:head>

<div class="px-8 py-8">
  <h1 class="text-3xl font-semibold tracking-tight">Components</h1>
  <ul class="mt-4 flex flex-col gap-2">
    {#each data.nav as item (item.href)}
      <li><a href={item.href} class="underline underline-offset-4">{item.title}</a></li>
    {/each}
  </ul>
</div>
