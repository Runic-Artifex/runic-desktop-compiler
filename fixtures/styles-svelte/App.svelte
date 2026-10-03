<script lang="ts">
  let color = $state<string | undefined>('rgb(32, 80, 160)');
  let width = $state(120);
  let base = $state('margin: 4px;  PADDING:6px');
  let tone = $state('#dfe7f0');
</script>

<main>
  <div class="row">
    <button id="color" onclick={() => (color = color ? undefined : 'rgb(32, 80, 160)')}>Color</button>
    <button id="wider" onclick={() => (width += 20)}>Wider</button>
    <button id="base" onclick={() => (base = base.startsWith('margin') ? 'padding: 2px; color: green' : 'margin: 4px;  PADDING:6px')}>Base</button>
    <button id="tone" onclick={() => (tone = tone === '#dfe7f0' ? '#f0e7df' : '#dfe7f0')}>Tone</button>
  </div>
  <p id="directive" style:color={color} style:width={`${width}px`}>Directive</p>
  <p id="text" style={base}>Text</p>
  <p id="both" style="border: 1px solid #52665b" style:background-color={tone}>Both</p>
  <p id="mixed" style={base} style:color={color}>Mixed</p>
  <p id="static" style="color: RED">Static</p>
</main>
