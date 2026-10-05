<script lang="ts">
  // CSS on inline SVG content, drawn by the Blitz fork from each element's
  // computed SVG properties (docs/BLITZ-GAPS.md, fixed in the fork):
  // Tailwind fill and stroke utilities on lucide icons, a group variant
  // filling an icon (shadcn-svelte's toggle-demo pattern), stylesheet paint
  // properties on children, display, visibility, opacity and transforms of
  // children, presentation attributes against inherited CSS, and
  // currentColor inherited by a child whose own color differs.
  import HeartIcon from '@lucide/svelte/icons/heart';
  import StarIcon from '@lucide/svelte/icons/star';
  import BookmarkIcon from '@lucide/svelte/icons/bookmark';
  import CircleIcon from '@lucide/svelte/icons/circle';

  let pressed = $state(false);
  let filled = $state(false);
  let hidden = $state(true);
</script>

<main class="flex flex-col gap-3 p-4 font-sans text-slate-900">
  <div id="utilities" class="flex w-fit gap-4 p-1">
    <HeartIcon size={48} class="fill-rose-500 stroke-rose-800" />
    <StarIcon size={48} class="fill-amber-300 stroke-none" />
    <BookmarkIcon size={48} class="stroke-sky-600 stroke-1" />
    <CircleIcon size={48} class="fill-emerald-200 stroke-emerald-700 stroke-[3]" />
  </div>

  <div id="buttons" class="flex w-fit gap-3 p-1">
    <button
      id="press"
      aria-pressed={pressed}
      class="group flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
      onclick={() => (pressed = !pressed)}
    >
      <BookmarkIcon size={32} class="group-aria-pressed:fill-current" />
      Bookmark
    </button>
    <button
      id="hover"
      class="group flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-sky-800"
    >
      <HeartIcon size={32} class="group-hover:fill-sky-300 group-hover:stroke-sky-900" />
      Hover
    </button>
    <button id="fill" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onclick={() => (filled = !filled)}>
      Fill
    </button>
    <button id="show" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onclick={() => (hidden = !hidden)}>
      Show
    </button>
  </div>

  <div id="children" class="flex w-fit gap-4 p-1 text-slate-700">
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10" class={hidden ? 'hidden' : 'stroke-violet-500'} />
      <rect x="4" y="4" width="16" height="16" class="fill-slate-400 opacity-30" />
      <path d="M4 12h16" class="invisible" />
      <path d="M12 4v16" class="text-rose-600" />
    </svg>
    <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <g class="invisible">
        <rect x="2" y="2" width="8" height="8" />
        <rect x="14" y="2" width="8" height="8" class="visible fill-teal-600" />
      </g>
      <rect x="8" y="12" width="8" height="8" class="origin-center rotate-45 fill-amber-500" />
      <rect x="2" y="14" width="6" height="6" transform="translate(14 0)" class={filled ? 'fill-indigo-600' : 'fill-indigo-200'} />
    </svg>
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" class="dashed" />
      <path d="M5 5 19 19" class="thin stroke-rose-700" />
      <path d="M2 2h20v20H2z M7 7h10v10H7z" class="ghost fill-sky-700" stroke="none" />
      <g transform="translate(12 0)" class="shifted">
        <path d="M2 10 6 2 10 10" class="mitre stroke-emerald-700" stroke-width="1.5" />
      </g>
    </svg>
  </div>

  <div id="attributes" class="flex w-fit items-center gap-4 p-1 text-rose-600">
    <svg width="60" height="20" viewBox="0 0 30 10" class="fill-slate-900">
      <polygon points="0,0 30,0 15,10" />
    </svg>
    <svg width="60" height="20" viewBox="0 0 30 10" class="fill-slate-900">
      <polygon points="0,0 30,0 15,10" fill="currentColor" />
    </svg>
    <svg width="48" height="48" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" class="stroke-sky-600 text-slate-900">
      <path d="M4 20 12 4 20 20" />
      <path d="M8 14h8" stroke="currentColor" />
    </svg>
    <div class="size-4 rotate-45 rounded-[2px] bg-slate-900 fill-slate-900"></div>
  </div>

  <p id="state">{pressed} {filled} {hidden}</p>
</main>
