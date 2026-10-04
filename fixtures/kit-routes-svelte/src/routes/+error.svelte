<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>Error {page.status}</title>
</svelte:head>

<h1 id="error">{page.status}</h1>
<p>{page.error?.message}</p>
