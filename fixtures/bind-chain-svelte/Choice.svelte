<script lang="ts">
  // shadcn-svelte's DropdownMenu.RadioGroup shape: `value = $bindable()`
  // without a default bound to a prop with one.
  import ChoiceCore from './ChoiceCore.svelte';

  let { value = $bindable(), ...rest }: { value?: string; options: string[]; id: string } = $props();
</script>

<ChoiceCore bind:value {...rest} />
<p class="echo">{value ?? 'none'}</p>
