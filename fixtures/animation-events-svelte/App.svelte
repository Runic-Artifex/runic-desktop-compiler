<script lang="ts">
  // CSS animation and transition events (CSS slice 3b), on virtual time:
  // start, iteration and end with their elapsedTime; a delay and a negative
  // delay; a pseudo-element's events (pseudoElement); a transition's run,
  // start and end, and a reversal (cancel, then a shortened transition);
  // display: none on an ancestor (cancel, bubbling to the ancestor's
  // listener) and shown again (a new animation); a document listener after
  // the element's. Every line carries the number of the animation frame
  // callbacks run so far, so the order against the frame's callbacks shows:
  // the `finished` reaction first, then the events, then the callbacks
  // (also those the reaction and a listener request, in the same frame).
  import { onMount } from 'svelte';

  let log = $state('');
  let frames = 0;
  let on = $state(false);
  let hidden = $state(false);
  let a = $state<HTMLElement | null>(null);

  function add(line: string) {
    log = log + frames + ' ' + line + '\n';
  }
  function anim(e: AnimationEvent, who: string) {
    add(who + ' ' + e.type + ' ' + e.animationName + ' ' + e.elapsedTime + (e.pseudoElement === '' ? '' : ' ' + e.pseudoElement));
  }
  function trans(e: TransitionEvent) {
    add('t ' + e.type + ' ' + e.propertyName + ' ' + e.elapsedTime);
  }
  function end(e: AnimationEvent) {
    anim(e, 'a');
    requestAnimationFrame(() => add('a raf from listener'));
  }

  onMount(() => {
    let id = 0;
    const tick = () => {
      frames = frames + 1;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    for (const animation of a!.getAnimations())
      animation.finished.then(() => {
        add('a finished');
        requestAnimationFrame(() => add('a raf from finished'));
      });
    return () => cancelAnimationFrame(id);
  });
</script>

<svelte:document onanimationend={(e: AnimationEvent) => anim(e, 'document')} />

<div class="controls">
  <button id="toggle" onclick={() => (on = !on)}>toggle</button>
  <button id="hide" onclick={() => (hidden = !hidden)}>hide</button>
</div>
<div class="rows">
  <div class="row"><div id="a" class="box" bind:this={a} onanimationstart={(e) => anim(e, 'a')} onanimationiteration={(e) => anim(e, 'a')} onanimationend={end}></div></div>
  <div class="row"><div id="b" class="box" onanimationstart={(e) => anim(e, 'b')} onanimationend={(e) => anim(e, 'b')}></div></div>
  <div class="row"><div id="c" class="box" onanimationstart={(e) => anim(e, 'c')} onanimationend={(e) => anim(e, 'c')}></div></div>
  <div class="row"><div id="e" class="box" onanimationstart={(e) => anim(e, 'e')} onanimationend={(e) => anim(e, 'e')}></div></div>
  <div class="row"><div id="t" class={on ? 'box on' : 'box'} ontransitionrun={trans} ontransitionstart={trans} ontransitionend={trans} ontransitioncancel={trans}></div></div>
  <div class={hidden ? 'row hidden' : 'row'} id="p" onanimationstart={(e) => anim(e, 'p')} onanimationcancel={(e) => anim(e, 'p')}>
    <div id="d" class="box"></div>
  </div>
</div>
<pre id="log">{log}</pre>
