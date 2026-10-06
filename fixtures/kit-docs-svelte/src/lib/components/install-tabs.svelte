<script lang="ts">
  // The installation instructions' two tabs (the site's install-tabs.svelte
  // keeps the choice in its user config, a cookie).
  import * as Tabs from '$lib/registry/ui/tabs/index.js';
  import type { Snippet } from 'svelte';

  let { cli, manual }: { cli: Snippet; manual: Snippet } = $props();
</script>

<Tabs.Root value="cli" class="relative mt-6 w-full">
  <Tabs.List>
    <Tabs.Trigger value="cli">CLI</Tabs.Trigger>
    <Tabs.Trigger value="manual">Manual</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="cli">
    {@render cli()}
  </Tabs.Content>
  <Tabs.Content value="manual">
    {@render manual()}
  </Tabs.Content>
</Tabs.Root>
