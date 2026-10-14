<script lang="ts">
  // getAnimations() of filled animations after their end (CSS slice 3a):
  // Chromium keeps a finished CSS animation listed while its fill keeps it
  // in effect, with playState "finished", the same object, and its
  // `finished` promise resolved at the frame that saw the end.
  let marked = $state(false);
  let unfilled = $state(false);
  let hidden = $state(false);
  let renamed = $state(false);
  let fwd = $state<HTMLElement | null>(null);
  let both = $state<HTMLElement | null>(null);
  let alt = $state<HTMLElement | null>(null);
  let filled = $state<HTMLElement | null>(null);
  let unfilledBox = $state<HTMLElement | null>(null);
  let plain = $state<HTMLElement | null>(null);
  let hide = $state<HTMLElement | null>(null);
  let rename = $state<HTMLElement | null>(null);
  let held: Animation[] = [];
  let log = $state('');
  let out = $state('');

  function hold(name: string, el: HTMLElement | null) {
    for (const a of el!.getAnimations()) {
      held.push(a);
      a.finished.then(
        () => (log = log + name + ' '),
        () => (log = log + name + '! '),
      );
    }
  }
  function track() {
    hold('fwd', fwd);
    hold('both', both);
    hold('alt', alt);
    hold('unfilled', unfilledBox);
    hold('plain', plain);
    hold('hide', hide);
    hold('rename', rename);
  }
  function states(el: HTMLElement | null): string {
    const s = el!
      .getAnimations()
      .map(a => a.playState)
      .join(',');
    return s === '' ? '-' : s;
  }
  function read() {
    const first = fwd!.getAnimations();
    const same = held.length > 0 && first.length > 0 && first[0] === held[0];
    out =
      [states(fwd), states(both), states(alt), states(unfilledBox), states(plain), states(hide), states(rename)].join(' ') +
      ' | ' +
      held.map(a => a.playState).join(',') +
      ' | ' +
      (same ? 'same' : 'other');
  }
  function late() {
    // Taken after its end: its `finished` promise is already resolved.
    for (const a of filled!.getAnimations()) a.finished.then(() => (log = log + 'late '));
    log = log + 'asked ';
  }
</script>
<main>
  <div class="controls">
    <button id="track" onclick={track}>Track</button>
    <button id="read" onclick={read}>Read</button>
    <button id="late" onclick={late}>Late</button>
    <button id="mark" onclick={() => (marked = !marked)}>Mark</button>
    <button id="unfill" onclick={() => (unfilled = !unfilled)}>Unfill</button>
    <button id="toggle" onclick={() => (hidden = !hidden)}>Hide</button>
    <button id="swap" onclick={() => (renamed = !renamed)}>Rename</button>
  </div>
  <p id="log">{log}</p>
  <p id="out">{out}</p>
  <div id="rows" class={marked ? 'rows marked' : 'rows'}>
    <div id="row-fwd" class="row"><div id="fwd" class="box" bind:this={fwd}></div></div>
    <div id="row-both" class="row"><div id="both" class="box" bind:this={both}></div></div>
    <div id="row-alt" class="row"><div id="alt" class="box" bind:this={alt}></div></div>
    <div id="row-var" class="row"><div id="var" class="box" bind:this={filled}></div></div>
    <div id="row-unfilled" class="row"><div id="unfilled" class="box" bind:this={unfilledBox} style:animation-fill-mode={unfilled ? 'none' : 'forwards'}></div></div>
    <div id="row-plain" class="row"><div id="plain" class="box" bind:this={plain}></div></div>
    <div id="row-hide" class="row"><div id="hide" class={hidden ? 'box hidden' : 'box'} bind:this={hide}></div></div>
    <div id="row-rename" class="row"><div id="rename" class={renamed ? 'box renamed' : 'box'} bind:this={rename}></div></div>
  </div>
</main>
