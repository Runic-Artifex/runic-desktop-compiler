<script lang="ts">
  // shadcn-svelte's checkbox examples (basic, description, disabled, group,
  // invalid) over bits-ui's Checkbox compiled from its published source,
  // through the unmodified checkbox, label and field wrappers
  // (src/lib/registry: upstream sources, see vendor.json). Each Checkbox
  // passes a name, so the Root's `name = undefined` default never runs.
  import CheckboxBasic from '$lib/registry/examples/checkbox-basic.svelte';
  import CheckboxDescription from '$lib/registry/examples/checkbox-description.svelte';
  import CheckboxDisabled from '$lib/registry/examples/checkbox-disabled.svelte';
  import CheckboxGroup from '$lib/registry/examples/checkbox-group.svelte';
  import CheckboxInvalid from '$lib/registry/examples/checkbox-invalid.svelte';
</script>

<div class="style-vega flex flex-col gap-6 bg-background p-4 font-sans text-foreground">
  <div id="basic"><CheckboxBasic /></div>
  <div id="description"><CheckboxDescription /></div>
  <div id="disabled"><CheckboxDisabled /></div>
  <div id="invalid"><CheckboxInvalid /></div>
  <div id="group"><CheckboxGroup /></div>
</div>
