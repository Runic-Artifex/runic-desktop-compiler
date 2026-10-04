<script lang="ts">
  import { page } from '$app/state';
</script>

<p id="item-error">Items error {page.status}: {page.error?.message}</p>
