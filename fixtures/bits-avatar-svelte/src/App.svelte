<script lang="ts">
  // bits-ui's Avatar compiled from its published source, through
  // shadcn-svelte's avatar wrappers (src/lib/registry: unmodified upstream
  // sources, see vendor.json), as its demos arrange them. Avatar.Image
  // loads its source with `new Image()` (bits-ui's root state) and renders
  // an <img> of the same source; both are pinned by `runic images`
  // (runic.images.json): two GitHub avatars and a pinned 404.
  import * as Avatar from '$lib/registry/ui/avatar/index.js';

  const SHADCN = 'https://github.com/shadcn.png?size=40';
  const RABBIT = 'https://github.com/evilrabbit.png?size=40';
  const MISSING = 'https://github.com/runic-artifex-no-such-user-404.png?size=40';

  let size = $state<'default' | 'sm' | 'lg'>('default');
  let count = $state(3);
  let switched: typeof MISSING | typeof RABBIT = $state(MISSING);
  let trace = $state<string[]>([]);
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="avatars" class="flex flex-row flex-wrap items-center gap-6">
    <Avatar.Root id="cn" {size}>
      <Avatar.Image src={SHADCN} alt="@shadcn" />
      <Avatar.Fallback>CN</Avatar.Fallback>
    </Avatar.Root>
    <Avatar.Root id="er" {size}>
      <Avatar.Image src={MISSING} alt="@missing" />
      <Avatar.Fallback>ER</Avatar.Fallback>
      <Avatar.Badge class="bg-green-600" />
    </Avatar.Root>
    <Avatar.Group id="group">
      <Avatar.Root size="sm">
        <Avatar.Image src={SHADCN} alt="@shadcn" />
        <Avatar.Fallback>CN</Avatar.Fallback>
      </Avatar.Root>
      <Avatar.Root size="sm">
        <Avatar.Image src={RABBIT} alt="@evilrabbit" />
        <Avatar.Fallback>ER</Avatar.Fallback>
      </Avatar.Root>
      <Avatar.GroupCount>+{count}</Avatar.GroupCount>
    </Avatar.Group>
    <Avatar.Root
      id="delayed"
      delayMs={500}
      onLoadingStatusChange={s => (trace = [...trace, `delayed ${s}`])}
    >
      <Avatar.Image src={RABBIT} alt="@evilrabbit" />
      <Avatar.Fallback>DL</Avatar.Fallback>
    </Avatar.Root>
    <Avatar.Root id="switch" onLoadingStatusChange={s => (trace = [...trace, `switch ${s}`])}>
      <Avatar.Image src={switched} alt="switched" />
      <Avatar.Fallback>SW</Avatar.Fallback>
    </Avatar.Root>
  </div>
  <div class="flex gap-2">
    <button id="small" class="rounded-md border px-3 py-1 text-sm" onclick={() => (size = 'sm')}>Small</button>
    <button id="large" class="rounded-md border px-3 py-1 text-sm" onclick={() => (size = 'lg')}>Large</button>
    <button id="more" class="rounded-md border px-3 py-1 text-sm" onclick={() => count++}>More</button>
    <button id="swap" class="rounded-md border px-3 py-1 text-sm" onclick={() => (switched = RABBIT)}>Swap</button>
  </div>
  <p id="trace" class="text-sm">{trace.join(', ')}</p>
</div>
