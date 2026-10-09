<script lang="ts">
  // Diagnostic reduction, intentionally not imported by the pass fixture entry.
  let form: HTMLElement | null = null;
  let log = $state('ready');
  function note(s: string) {
    log = (log === 'ready' ? s : log + ' ' + s).slice(-512);
  }
  function submit(e: Event) {
    e.preventDefault();
    note('submit');
  }
  function request() {
    note('before');
    form?.requestSubmit();
    note('after');
  }
</script>

<main>
  <form id="gap-form" bind:this={form} onsubmit={submit}>
    <input id="gap-field" type="text" aria-label="Required field" required />
    <button id="gap-default" type="submit" formnovalidate>Bypass only for this button</button>
  </form>
  <button id="gap-request" type="button" onclick={request}>Request without submitter</button>
  <p id="log">{log}</p>
</main>
