<script lang="ts">
  // shadcn-svelte's scroll-fade examples (docs/src/lib/registry/examples/
  // scroll-fade-{demo,overflow,horizontal,size,none}.svelte at 3ef557c),
  // their other Tailwind classes replaced by plain-CSS stand-ins.
  const items = Array.from({ length: 12 }, (_, index) => index + 1);
  const few = Array.from({ length: 3 }, (_, index) => index + 1);
  const eight = Array.from({ length: 8 }, (_, index) => index + 1);
  const tags = [
    'Design',
    'Engineering',
    'Marketing',
    'Product',
    'Research',
    'Sales',
    'Support',
    'Operations',
    'Finance',
    'Legal',
    'People',
    'Security',
  ];
</script>

{#snippet sizeItems()}
  <div class="list">
    {#each eight as item (item)}
      <div class="item">Item {item}</div>
    {/each}
  </div>
{/snippet}

{#snippet noneItems()}
  <div class="list">
    {#each eight as item (item)}
      <div class="item">Item {item}</div>
    {/each}
  </div>
{/snippet}

<main>
  <!-- scroll-fade-demo -->
  <div class="frame">
    <div id="demo" class="no-scrollbar h-72 scroll-fade overflow-y-auto">
      <div class="list">
        {#each items as item (item)}
          <div class="item">Item {item}</div>
        {/each}
      </div>
    </div>
  </div>
  <!-- scroll-fade-overflow: content that does not overflow (an inactive timeline) -->
  <div class="frame">
    <div id="overflow" class="no-scrollbar scroll-fade overflow-y-auto">
      <div class="list">
        {#each few as item (item)}
          <div class="item">Item {item}</div>
        {/each}
      </div>
    </div>
  </div>
  <!-- scroll-fade-horizontal -->
  <div class="frame">
    <div id="horizontal" class="no-scrollbar scroll-fade-x overflow-x-auto">
      <div class="row">
        {#each tags as tag (tag)}
          <div class="item">{tag}</div>
        {/each}
      </div>
    </div>
  </div>
  <!-- scroll-fade-size -->
  <div class="stack">
    <div class="group">
      <div class="frame">
        <div id="size-4" class="no-scrollbar h-48 scroll-fade overflow-y-auto scroll-fade-4">{@render sizeItems()}</div>
      </div>
      <p class="caption">scroll-fade-4</p>
    </div>
    <div class="group">
      <div class="frame">
        <div id="size-24" class="no-scrollbar h-48 scroll-fade overflow-y-auto scroll-fade-24">{@render sizeItems()}</div>
      </div>
      <p class="caption">scroll-fade-24</p>
    </div>
  </div>
  <!-- scroll-fade-none -->
  <div class="stack">
    <div class="group">
      <div class="frame">
        <div id="fade" class="no-scrollbar h-48 scroll-fade overflow-y-auto">{@render noneItems()}</div>
      </div>
      <p class="caption">scroll-fade</p>
    </div>
    <div class="group">
      <div class="frame">
        <div id="none" class="no-scrollbar h-48 scroll-fade overflow-y-auto scroll-fade-none">{@render noneItems()}</div>
      </div>
      <p class="caption">scroll-fade scroll-fade-none</p>
    </div>
  </div>
</main>
