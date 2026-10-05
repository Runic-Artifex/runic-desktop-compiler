<script lang="ts">
  // bits-ui's Avatar compiled from its published source, through
  // shadcn-svelte's avatar wrappers (src/lib/registry: unmodified upstream
  // sources, see vendor.json), as its demos arrange them but without
  // Avatar.Image: loading an image is rejected (the native runtime fetches
  // no images; every avatar demo loads one from github.com), so the avatars
  // show their fallbacks, as the demos do while their images load or fail.
  import * as Avatar from '$lib/registry/ui/avatar/index.js';

  let size = $state<'default' | 'sm' | 'lg'>('default');
  let count = $state(3);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="avatars" class="flex flex-row flex-wrap items-center gap-6">
    <Avatar.Root id="cn" {size}>
      <Avatar.Fallback>CN</Avatar.Fallback>
    </Avatar.Root>
    <Avatar.Root id="er" {size}>
      <Avatar.Fallback>ER</Avatar.Fallback>
      <Avatar.Badge class="bg-green-600" />
    </Avatar.Root>
    <Avatar.Group id="group">
      <Avatar.Root size="sm">
        <Avatar.Fallback>CN</Avatar.Fallback>
      </Avatar.Root>
      <Avatar.Root size="sm">
        <Avatar.Fallback>LR</Avatar.Fallback>
      </Avatar.Root>
      <Avatar.GroupCount>+{count}</Avatar.GroupCount>
    </Avatar.Group>
  </div>
  <div class="flex gap-2">
    <button id="small" class="rounded-md border px-3 py-1 text-sm" onclick={() => (size = 'sm')}>Small</button>
    <button id="large" class="rounded-md border px-3 py-1 text-sm" onclick={() => (size = 'lg')}>Large</button>
    <button id="more" class="rounded-md border px-3 py-1 text-sm" onclick={() => count++}>More</button>
  </div>
</div>
