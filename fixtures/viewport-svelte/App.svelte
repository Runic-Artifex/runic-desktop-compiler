<script lang="ts">
  // Media query lists and their change events, the window's resize event,
  // in the rendering step after the viewport or the preferences change.
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const wide = matchMedia('(min-width: 600px)');
  let log = $state<string[]>([]);
  let now = $state('');

  const onDark = (e: MediaQueryListEvent) => log.push(`dark ${e.matches} ${e.type}`);
  const onWide = () => log.push(`wide ${wide.matches}`);
  const onResize = () => log.push('resize');

  $effect(() => {
    dark.addEventListener('change', onDark);
    wide.addEventListener('change', onWide);
    // Adding the same listener again does nothing.
    wide.addEventListener('change', onWide);
    window.addEventListener('resize', onResize);
    return () => {
      dark.removeEventListener('change', onDark);
      wide.removeEventListener('change', onWide);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<main>
  <div class="row">
    <button id="read" onclick={() => (now = `${dark.matches} ${wide.matches} ${dark === wide}`)}>Read</button>
    <button id="quiet" onclick={() => wide.removeEventListener('change', onWide)}>Quiet</button>
  </div>
  <p id="now">{now}</p>
  <p id="log">{log.join(', ')}</p>
</main>
