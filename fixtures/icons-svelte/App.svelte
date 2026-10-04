<script lang="ts">
  let warm = $state(false);
  let done = $state(false);
  let weight = $state(2);
  let size = $state(24);
  let dots = $state([6, 12]);
</script>

<main>
  <h1 id="title">Icons</h1>
  <div class="row">
    <button id="tone" onclick={() => (warm = !warm)}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
      Tone
    </button>
    <button id="done" onclick={() => (done = !done)}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        {#if done}
          <path d="M20 6 9 17l-5-5" />
        {:else}
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        {/if}
      </svg>
      Done
    </button>
    <button id="weight" onclick={() => (weight = weight === 2 ? 3 : 2)}>Weight</button>
    <button id="size" onclick={() => (size = size === 24 ? 32 : 24)}>Size</button>
    <button id="dot" onclick={() => (dots = [...dots, 18])}>Dot</button>
  </div>
  <div id="palette" class={warm ? 'row warm' : 'row'}>
    <svg id="panel" xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={weight} stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path class="accent" stroke="currentColor" d="M9 3v18" />
    </svg>
    <svg id="alert" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" /> <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
    <svg id="star" width="32" height="32" viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter" stroke-miterlimit="8">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
    <svg id="pulse" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="bevel">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
    <svg id="frame" class="big" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd">
      <path d="M2 2h20v20H2z M7 7h10v10H7z" />
    </svg>
  </div>
  <div class="row">
    <svg id="dots" width="48" height="24" viewBox="0 0 24 12" fill="#52665b" stroke="none">
      <ellipse cx="12" cy="6" rx="11" ry="5" fill="none" stroke="#b7b7a9" stroke-width="1" stroke-dasharray="2 1" stroke-dashoffset="1" />
      {#each dots as x}
        <circle cx={x} cy="6" r="2" />
      {/each}
    </svg>
    <svg id="spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a0452a" stroke-width="2" stroke-linecap="round" stroke-opacity="0.8">
      <g transform="rotate(45 12 12)" opacity="0.5">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </g>
    </svg>
  </div>
  <p id="state">{warm} {done} {weight} {size} {dots.length}</p>
</main>
