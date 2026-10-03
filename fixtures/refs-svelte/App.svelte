<script lang="ts">
  let input: HTMLInputElement;
  let details = $state<HTMLButtonElement | null>(null);
  let text = $state('');
  let show = $state(true);
  let status = $state('unchecked');
  function check() {
    status = details === null || details === undefined ? 'details gone' : 'details mounted';
  }
</script>
<main><h1 id="title">Refs</h1>
<p><input id="field" aria-label="Field" type="text" bind:this={input} bind:value={text} onkeydown={(e) => { if (e.key === 'Escape') input.blur(); }} /></p>
<p id="echo">Text: {text}</p>
<div class="controls"><button id="focus" onclick={() => input.focus()}>Focus field</button><button id="toggle" onclick={() => show = !show}>Toggle</button><button id="check" onclick={check}>Check</button><button id="focus-details" onclick={() => details?.focus()}>Focus details</button><button id="hide-focus" onclick={() => { show = false; details?.focus(); }}>Hide and focus</button></div>
{#if show}<p><button id="details" bind:this={details}>Details</button></p>{/if}
<p id="status">{status}</p>
</main>
