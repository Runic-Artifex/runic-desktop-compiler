<script lang="ts">
  import { ThemeContext } from './theme.ts';

  let { label }: { label: string } = $props();
  const theme = ThemeContext.get();
</script>

<span class="badge {theme}">{label}: {theme}</span>
