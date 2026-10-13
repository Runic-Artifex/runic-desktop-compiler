<script lang="ts">
  import { useId } from 'bits-ui';
  import Field from './Field.svelte';
  import Palette from './Palette.svelte';

  let { name }: { name: string } = $props();
</script>

<section class="section">
  <Field label={name} value={`${useId('field')}`} />
  <Palette {name} />
</section>
