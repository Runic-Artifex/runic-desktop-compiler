<script lang="ts">
  // Differential only (interpreter against native code), no conformance
  // case: a dynamic value reaching a static slot of another type throws
  // RunicUnsupportedError where the browser would go on with the wrong type
  // (docs/design/M6-DYNAMIC-VALUES.md).
  import { pick } from './lib.js';
  let out = $state(0);
  let error = $state('');
  function take(flag: boolean) {
    error = '';
    try {
      const n: number = pick(flag);
      out = n + 1;
    } catch (e) {
      error = (e as Error).name;
    }
  }
</script>

<main>
  <p id="out">{out} {error}</p>
  <div class="controls">
    <button id="ok" onclick={() => take(true)}>Number</button>
    <button id="bad" onclick={() => take(false)}>String</button>
  </div>
</main>
