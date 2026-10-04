<script lang="ts">
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  let opened = $state(0);
</script>

<section id="items">
  <div class="row">
    <h2>{data.section}</h2>
    <button id="items-open" onclick={() => opened++}>Opened {opened}</button>
  </div>
  {@render children()}
</section>
