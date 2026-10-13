<script lang="ts">
  // The prop's default makes Svelte read it at this declaration ($.prop):
  // the parent's derived value takes its id before this component's own.
  import { useId } from 'bits-ui';

  let { value = '', label }: { value?: string; label: string } = $props();
  const own = useId();
</script>

<p class="field" data-value={value} data-own={own}>{label}: {value} / {own}</p>
