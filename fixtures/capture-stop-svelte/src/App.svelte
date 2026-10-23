<script lang="ts">
  // stopPropagation in a capture listener ends the dispatch at its
  // invocation (DOM standard: one per node and phase): the node's own
  // bubbling listeners, and at the target its non-capture ones, do not run;
  // a stop at the container (Svelte's delegation root) keeps every
  // delegated template handler from running, since they run from the
  // root's bubbling listener. Physical clicks, a nested click() and a
  // script dispatchEvent take the same path.
  import { onMount } from 'svelte';

  let mode = $state('open');
  let log = $state('ready');
  let outer = $state<HTMLElement | null>(null);
  let inner = $state<HTMLElement | null>(null);
  let target = $state<HTMLElement | null>(null);

  function note(s: string): void {
    log = (log === 'ready' ? s : log + ' ' + s).slice(-480);
  }
  function select(m: string): void {
    mode = m;
    log = 'ready';
  }

  // At the container: only for events at the target.
  function rootCapture(e: Event): void {
    if (e.target !== target) return;
    note('rc');
    if (mode === 'root-stop') e.stopPropagation();
  }
  function rootBubble(e: Event): void {
    if (e.target !== target) return;
    note('rb');
  }
  function documentBubble(e: Event): void {
    if (e.target !== target) return;
    note('d');
  }
  function outerCapture(e: Event): void {
    note('oc');
    if (mode === 'outer-stop') e.stopPropagation();
    if (mode === 'outer-immediate') e.stopImmediatePropagation();
  }
  function outerCapture2(): void {
    note('oc2');
  }
  function outerBubble(): void {
    note('ob');
  }
  function innerBubble(): void {
    note('si');
  }
  function targetCapture(e: Event): void {
    note('tc');
    if (mode === 'target-stop') e.stopPropagation();
  }
  function targetCapture2(): void {
    note('tc2');
  }
  function targetBubble(): void {
    note('ts');
  }

  // Template listeners: Svelte delegates click (run from the root), and
  // runs `onclickcapture` as a capture listener of its element.
  const innerBag = {
    onclickcapture: (e: MouseEvent) => {
      note('tic');
      if (mode === 'template-stop') e.stopPropagation();
    },
    onclick: () => note('ti'),
  };

  function nestedClick(): void {
    note('n<');
    target?.click();
    note('>n');
  }
  function nestedDispatch(): void {
    note('d<');
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    note('>d');
  }

  onMount(() => {
    // (The container, where Svelte mounts the program and listens.)
    const root = document.querySelector<HTMLElement>('#root');
    root?.addEventListener('click', rootCapture, true);
    root?.addEventListener('click', rootBubble);
    document.addEventListener('click', documentBubble);
    outer?.addEventListener('click', outerCapture, true);
    outer?.addEventListener('click', outerCapture2, true);
    outer?.addEventListener('click', outerBubble);
    inner?.addEventListener('click', innerBubble);
    // (The target's bubbling listener first: at the target capture
    // listeners still run before it.)
    target?.addEventListener('click', targetBubble);
    target?.addEventListener('click', targetCapture, true);
    target?.addEventListener('click', targetCapture2, true);
    return () => {
      root?.removeEventListener('click', rootCapture, true);
      root?.removeEventListener('click', rootBubble);
      document.removeEventListener('click', documentBubble);
      outer?.removeEventListener('click', outerCapture, true);
      outer?.removeEventListener('click', outerCapture2, true);
      outer?.removeEventListener('click', outerBubble);
      inner?.removeEventListener('click', innerBubble);
      target?.removeEventListener('click', targetBubble);
      target?.removeEventListener('click', targetCapture, true);
      target?.removeEventListener('click', targetCapture2, true);
    };
  });
</script>

<main>
  <section>
    <button id="mode-open" type="button" onclick={() => select('open')}>Open</button>
    <button id="mode-root-stop" type="button" onclick={() => select('root-stop')}>Stop at root</button>
    <button id="mode-outer-stop" type="button" onclick={() => select('outer-stop')}>Stop at outer</button>
    <button id="mode-outer-immediate" type="button" onclick={() => select('outer-immediate')}>
      Immediate at outer
    </button>
    <button id="mode-template-stop" type="button" onclick={() => select('template-stop')}>
      Stop in template capture
    </button>
    <button id="mode-target-stop" type="button" onclick={() => select('target-stop')}>Stop at target</button>
    <button id="nested-click" type="button" onclick={nestedClick}>Nested click</button>
    <button id="nested-dispatch" type="button" onclick={nestedDispatch}>Nested dispatch</button>
  </section>
  <div id="outer" bind:this={outer} onclick={() => note('to')} role="presentation">
    <section id="inner" bind:this={inner} {...innerBag}>
      <div id="target" bind:this={target} onclick={() => note('tt')} role="presentation">Target</div>
    </section>
  </div>
  <p id="mode">{mode}</p>
  <p id="log">{log}</p>
</main>
