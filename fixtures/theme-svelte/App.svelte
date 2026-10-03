<script lang="ts">
  type Mode = 'system' | 'light' | 'dark';
  const modes: Mode[] = ['system', 'light', 'dark'];
  const palettes = ['runic', 'moss', 'fjord'];
  let mode = $state<Mode>('system');
  let palette = $state('runic');
  let accent = $state(false);
  const wide = matchMedia('(min-width: 600px)').matches;

  function apply() {
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = mode === 'dark' || (mode === 'system' && systemDark);
    document.documentElement.dataset.reducedMotion = String(matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (accent) document.documentElement.style.setProperty('--desktop-accent', 'rgb(32 80 160)');
    else document.documentElement.style.removeProperty('--desktop-accent');
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = palette;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  $effect(() => {
    apply();
  });
</script>

<main>
  <h1 id="title">Appearance</h1>
  <div class="row">
    <button id="mode" onclick={() => (mode = modes[(modes.indexOf(mode) + 1) % modes.length])}>Mode</button>
    <button id="palette" onclick={() => (palette = palettes[(palettes.indexOf(palette) + 1) % palettes.length])}>Palette</button>
    <button id="accent" onclick={() => (accent = !accent)}>Accent</button>
  </div>
  <p id="state">{mode} {palette} {accent} {wide}</p>
</main>
