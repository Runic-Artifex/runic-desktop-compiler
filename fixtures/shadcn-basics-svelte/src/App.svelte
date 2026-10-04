<script lang="ts">
  // shadcn-svelte's Button, Badge and Card (src/lib/registry/ui: unmodified
  // upstream sources, see vendor.json) used as the shadcn-svelte demos use
  // them: variants and sizes, a class passed through to cn, href turning
  // Button into a link, Badge as a link through <svelte:element>, Card's
  // parts through the namespace barrel, children snippets and rest props
  // (id, aria-label, onclick).
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
  import * as Card from '$lib/registry/ui/card/index.js';
  import { Button, buttonVariants } from '$lib/registry/ui/button/index.js';
  import { Badge } from '$lib/registry/ui/badge/index.js';

  let count = $state(0);
  let outlined = $state(false);
  let size = $state<'sm' | 'default' | 'lg'>('default');
  let disabled = $state(false);
  let wide = $state(false);
  // Links navigate to fragments: popstate at once, hashchange as a task.
  let pops = $state(0);
  let changes = $state(0);
  let hash = $state('');

  const steps = ['Choose a schedule.', 'Send to channels.', 'Include charts.'];

  function nextSize() {
    size = size === 'sm' ? 'default' : size === 'default' ? 'lg' : 'sm';
  }
</script>

<svelte:window
  onpopstate={() => pops++}
  onhashchange={() => {
    changes++;
    hash = location.hash;
  }}
/>

<div class="style-vega flex flex-col gap-4 bg-background p-4 font-sans text-foreground">
  <div class="flex flex-wrap items-center gap-2">
    <Button id="default" onclick={() => count++}>Button</Button>
    <Button id="outline" variant="outline" onclick={() => (outlined = !outlined)}>Outline</Button>
    <Button id="secondary" variant="secondary" onclick={nextSize}>Secondary</Button>
    <Button id="ghost" variant="ghost" onclick={() => (disabled = !disabled)}>Ghost</Button>
    <Button id="destructive" variant="destructive" onclick={() => (wide = !wide)}>Destructive</Button>
    <Button id="link" variant="link">Link</Button>
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <Button id="xs" size="xs" variant="outline">Extra Small</Button>
    <Button id="sm" size="sm" variant="outline">Small</Button>
    <Button id="lg" size="lg" variant="outline">Large</Button>
    <Button id="icon" size="icon" variant="outline" aria-label="Submit">
      <ArrowUpIcon />
    </Button>
    <Button id="dynamic" variant={outlined ? 'outline' : 'default'} {size} class={wide ? 'w-40' : undefined}>
      Dynamic
    </Button>
    <Button id="disabled" {disabled} variant="secondary">Disabled</Button>
    <Button id="as-link" href="#login" {disabled} variant="secondary" size="sm">Login</Button>
    <a id="variants-link" class={buttonVariants({ variant: 'outline', size: 'sm' })} href="#docs">Docs</a>
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <Badge id="badge">Badge</Badge>
    <Badge id="badge-secondary" variant="secondary">
      <BadgeCheckIcon data-icon="inline-start" />
      Verified
    </Badge>
    <Badge id="badge-destructive" variant="destructive">Destructive</Badge>
    <Badge id="badge-outline" variant="outline">Outline</Badge>
    <Badge id="badge-link" href="#status" variant="ghost">Open Link</Badge>
  </div>
  <Card.Root id="card" size="sm" class="w-full max-w-xs">
    <Card.Header>
      <Card.Title>Scheduled reports</Card.Title>
      <Card.Description>Weekly snapshots. No more manual exports.</Card.Description>
      <Card.Action>
        <Button id="card-action" variant="link">Sign Up</Button>
      </Card.Action>
    </Card.Header>
    <Card.Content>
      <ul class="grid gap-2 py-2 text-sm">
        {#each steps as step (step)}
          <li class="flex gap-2">
            <ChevronRightIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{step}</span>
          </li>
        {/each}
      </ul>
    </Card.Content>
    <Card.Footer class="flex-col gap-2">
      <Button id="card-submit" size="sm" class="w-full" onclick={() => count++}>Set up reports</Button>
      <Button id="card-outline" variant="outline" size="sm" class="w-full">See what's new</Button>
    </Card.Footer>
  </Card.Root>
  <p id="state">{count} {outlined} {size} {disabled} {wide}</p>
  <p id="navigation">{pops} {changes} {hash}</p>
</div>
