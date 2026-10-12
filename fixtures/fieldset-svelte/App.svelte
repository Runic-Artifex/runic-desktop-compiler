<script lang="ts">
  // <fieldset> and <legend> (HTML's rendering of the fieldset and legend
  // elements): the rendered legend (the first legend child) leaves the
  // fieldset's content and straddles its block-start border, which is not
  // painted behind it; the content is laid out in an anonymous box with the
  // fieldset's display, gap and padding.
  import FieldSet from './FieldSet.svelte';
  import FieldLegend from './FieldLegend.svelte';

  let legend = $state(true);
  let wide = $state(false);
  let clicks = $state(0);
  let agree = $state(true);
</script>

<main>
  <button
    id="toggle"
    onclick={() => {
      legend = !legend;
      wide = !wide;
      clicks++;
    }}>Toggle {clicks}</button
  >
  <fieldset id="plain">
    <legend id="plain-legend">Shipping</legend>
    <p id="plain-text">Content below the legend.</p>
  </fieldset>

  <div class="reset">
    <FieldSet id="field-set" class="sm">
      <FieldLegend id="field-legend">Payment Method</FieldLegend>
      <p id="field-description" data-slot="field-description" class="field-description">
        All transactions are secure and encrypted.
      </p>
      <div data-slot="field-group" class="field-group">
        <div role="group" data-slot="field" class="field" id="field">
          <label for="card" id="card-label">Name on card</label>
          <input id="card" type="text" placeholder="Ada Lovelace" />
        </div>
      </div>
    </FieldSet>
    <FieldSet id="label-set">
      <FieldLegend id="label-legend" variant="label">Show these items</FieldLegend>
      <div data-slot="field" class="field row" id="label-field">
        <input id="agree" type="checkbox" bind:checked={agree} />
        <label for="agree">Hard disks</label>
      </div>
    </FieldSet>
  </div>

  <div class="row">
    <fieldset id="late">
      <div id="late-before">before</div>
      <legend id="late-legend">Late</legend>
      <div id="late-after">after</div>
    </fieldset>
    <fieldset id="two">
      <legend id="two-first">First</legend>
      <legend id="two-second">Second</legend>
    </fieldset>
    <fieldset id="thick">
      <legend id="thick-legend">tiny</legend>
      <div id="thick-text">x</div>
    </fieldset>
  </div>

  <div class="row">
    <fieldset id="fancy">
      <legend id="fancy-legend">{wide ? 'A much wider legend' : 'Fancy'}</legend>
      <div id="fancy-text">margins, padding, background</div>
    </fieldset>
    <fieldset id="grid">
      <legend id="grid-legend">Grid</legend>
      <div id="grid-1">1</div>
      <div id="grid-2">2</div>
    </fieldset>
  </div>

  <div class="row">
    <fieldset id="sized">
      {#if legend}<legend id="sized-legend">Sized</legend>{/if}
      <div id="sized-text">height 60px</div>
    </fieldset>
    <fieldset id="shrink">
      <legend id="shrink-legend">A shrink-to-fit legend</legend>
      <div id="shrink-text">x</div>
    </fieldset>
    <fieldset id="end">
      <legend id="end-legend">End</legend>
      <div>x</div>
    </fieldset>
  </div>
</main>
