<script lang="ts">
  import ToggleGroup from './ToggleGroup.svelte';

  const items = [
    { value: 'b', label: 'Bold' },
    { value: 'i', label: 'Italic' },
    { value: 'u', label: 'Underline' },
  ];
</script>

<main>
  <h1>Class hierarchy</h1>
  <ToggleGroup type="single" name="align" {items} />
  <ToggleGroup type="multiple" name="format" {items} />
</main>
