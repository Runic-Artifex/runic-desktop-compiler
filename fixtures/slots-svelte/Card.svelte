<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, header, children }: { title: string; header?: Snippet<[string]>; children: Snippet } = $props();
</script>
<section id={`card-${title}`}><h2>{#if true}{@render header?.(title)}{/if}</h2>{@render children()}</section>
