<script lang="ts">
  // Bindings through wrapper chains in the shapes of shadcn-svelte's Slider
  // and DropdownMenu.RadioGroup over bits-ui: variables of the present type
  // bound to `value = $bindable()` props (no default) that are bound on to
  // components writing them only through svelte-toolbelt box setters.
  import Range from './Range.svelte';
  import Choice from './Choice.svelte';

  let range = $state([20, 60]);
  let position = $state('bottom');
</script>

<main>
  <h1>Bound chains</h1>
  <Range id="range" bind:value={range} max={100} />
  <p id="range-value">{range[0]} to {range[1]}</p>
  <div class="controls">
    <button id="range-reset" onclick={() => (range = [0, 100])}>Reset range</button>
    <button id="range-narrow" onclick={() => (range = [range[0] + 5, range[1] - 5])}>Narrow</button>
  </div>
  <Choice id="position" bind:value={position} options={['top', 'bottom', 'right']} />
  <p id="position-value">{position}</p>
  <div class="controls">
    <button id="outside-top" onclick={() => (position = 'top')}>Top from outside</button>
  </div>
  <Choice id="fixed" value="right" options={['left', 'right']} />
</main>
