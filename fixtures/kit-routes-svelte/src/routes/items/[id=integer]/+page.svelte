<script lang="ts">
  import type { PageProps } from './$types';

  let { data, params }: PageProps = $props();
  let likes = $state(0);
</script>

<svelte:head>
  <title>{data.item}</title>
</svelte:head>

<h3 id="item">{data.item} ({params.id}) · {data.tab} · {data.where}</h3>
<p id="details">Details of {data.item}</p>
<button id="like" onclick={() => likes++}>Likes {likes}</button>
