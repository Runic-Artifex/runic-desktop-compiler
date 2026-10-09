<script lang="ts">
  let form = $state<HTMLElement | null>(null);
  let other: HTMLElement | null = null;
  let detached: HTMLElement | null = null;
  let rendered: HTMLElement | null = null;
  let mode = $state('physical');
  let log = $state('ready');
  let show = $state(true);
  let phase = $state('idle');
  let armed = false;
  function note(s: string) {
    log = (log === 'ready' ? s : log + ' ' + s).slice(-512);
  }
  function select(s: string) {
    mode = s;
    log = 'ready';
    show = true;
    phase = 'idle';
    armed = s === 'continuous';
    detached = null;
  }
  function click(e: MouseEvent) {
    note(`click:${e.detail}:${e.target === e.currentTarget}`);
    if (mode === 'cancel' || mode === 'cancel-implicit') {
      e.preventDefault();
      note('canceled');
    }
  }
  function externalClick(e: MouseEvent) {
    note(`external:${e.detail}:${e.target === e.currentTarget}`);
  }
  function submit(e: Event) {
    e.preventDefault();
    note(`submit:${e.type}:${e.target === e.currentTarget}:${e.defaultPrevented}`);
    phase = 'submitted';
    if (mode === 'recursive') {
      note('inner-before');
      form?.requestSubmit();
      note('inner-after');
    }
    if (mode === 'cross') {
      note('cross-before');
      other?.requestSubmit();
      note('cross-after');
    }
    if (mode === 'remove') {
      detached = form;
      show = false;
      note('removed');
    }
  }
  function secondary(e: Event) {
    e.preventDefault();
    note('secondary');
  }
  function capture(e: Event) {
    if (mode !== 'capture') return;
    if (e.target === form) {
      note('capture-before');
      other?.requestSubmit();
      note('capture-after');
    } else {
      note('capture-secondary');
    }
  }
  function detach() {
    detached = form;
    show = false;
    note('detached');
  }
  function request() {
    if (mode === 'timer') {
      setTimeout(() => {
        phase = 'origin';
        note('timer-before');
        form?.requestSubmit();
        note('timer-after');
        queueMicrotask(() => note(`micro:${rendered?.textContent}`));
      }, 0);
      return;
    }
    note('before');
    const receiver = mode === 'detached' || mode === 'remove' ? detached || form : form;
    receiver?.requestSubmit();
    if (mode === 'sequential') {
      note('between');
      receiver?.requestSubmit();
    }
    note('after');
  }
  function move() {
    if (mode !== 'continuous' || !armed) return;
    armed = false;
    phase = 'origin';
    note('move-before');
    form?.requestSubmit();
    note('move-after');
    queueMicrotask(() => note(`micro:${rendered?.textContent}`));
  }
  document.addEventListener('submit', capture, true);
</script>

<main>
  <h1>Form submission</h1>
  <div class="modes">
    <button id="mode-physical" type="button" onclick={() => select('physical')}> physical </button>
    <button id="mode-cancel" type="button" onclick={() => select('cancel')}> cancel </button>
    <button id="mode-implicit" type="button" onclick={() => select('implicit')}> implicit </button>
    <button id="mode-cancel-implicit" type="button" onclick={() => select('cancel-implicit')}>
      cancel-implicit
    </button>
    <button id="mode-disabled" type="button" onclick={() => select('disabled')}> disabled </button>
    <button id="mode-one" type="button" onclick={() => select('one')}> one </button>
    <button id="mode-two" type="button" onclick={() => select('two')}> two </button>
    <button id="mode-two-disabled" type="button" onclick={() => select('two-disabled')}>
      two-disabled
    </button>
    <button id="mode-external-before" type="button" onclick={() => select('external-before')}>
      external-before
    </button>
    <button id="mode-external-after" type="button" onclick={() => select('external-after')}>
      external-after
    </button>
    <button id="mode-invalid" type="button" onclick={() => select('invalid')}> invalid </button>
    <button id="mode-duplicate" type="button" onclick={() => select('duplicate')}>
      duplicate
    </button>
    <button id="mode-novalidate" type="button" onclick={() => select('novalidate')}>
      novalidate
    </button>
    <button id="mode-button-bypass" type="button" onclick={() => select('button-bypass')}>
      button-bypass
    </button>
    <button id="mode-search" type="button" onclick={() => select('search')}> search </button>
    <button id="mode-tel" type="button" onclick={() => select('tel')}> tel </button>
    <button id="mode-password" type="button" onclick={() => select('password')}> password </button>
    <button id="mode-missing-type" type="button" onclick={() => select('missing-type')}>
      missing-type
    </button>
    <button id="mode-invalid-type" type="button" onclick={() => select('invalid-type')}>
      invalid-type
    </button>
    <button id="mode-request" type="button" onclick={() => select('request')}> request </button>
    <button id="mode-sequential" type="button" onclick={() => select('sequential')}>
      sequential
    </button>
    <button id="mode-recursive" type="button" onclick={() => select('recursive')}>
      recursive
    </button>
    <button id="mode-cross" type="button" onclick={() => select('cross')}> cross </button>
    <button id="mode-detached" type="button" onclick={() => select('detached')}> detached </button>
    <button id="mode-remove" type="button" onclick={() => select('remove')}> remove </button>
    <button id="mode-timer" type="button" onclick={() => select('timer')}> timer </button>
    <button id="mode-continuous" type="button" onclick={() => select('continuous')}>
      continuous
    </button>
    <button id="mode-capture" type="button" onclick={() => select('capture')}> capture </button>
  </div>
  <p id="mode">{mode}</p>
  <div class="arena">
    {#if mode === 'duplicate'}<div id="duplicate-owner">First matching ID is not a form</div>{/if}
    {#if mode === 'external-before'}<button
        id="external-before"
        type="submit"
        form="primary-form"
        onclick={externalClick}>Before owner</button
      >{/if}
    {#if show}<form
        id={mode === 'duplicate' ? 'duplicate-owner' : 'primary-form'}
        bind:this={form}
        novalidate={mode === 'novalidate'}
        onsubmit={submit}
      >
        <input
          id="field"
          aria-label="Submission field"
          type={mode === 'search'
            ? 'search'
            : mode === 'tel'
              ? 'tel'
              : mode === 'password'
                ? 'password'
                : mode === 'missing-type'
                  ? undefined
                  : mode === 'invalid-type'
                    ? 'not-a-type'
                    : 'text'}
          required={mode === 'novalidate' || mode === 'button-bypass'}
        />
        {#if mode === 'two' || mode === 'two-disabled'}<input
            id="blocker"
            aria-label="Extra blocker"
            type="text"
            disabled={mode === 'two-disabled'}
          />{/if}
        {#if mode !== 'one' && mode !== 'two' && mode !== 'two-disabled' && mode !== 'external-after'}<button
            id="submit-button"
            type="submit"
            form={mode === 'invalid'
              ? 'missing-owner'
              : mode === 'duplicate'
                ? 'duplicate-owner'
                : 'primary-form'}
            disabled={mode === 'disabled'}
            formnovalidate={mode === 'button-bypass'}
            onclick={click}><span id="submit-child">Nested submit</span></button
          >{/if}
        {#if mode === 'disabled'}<button id="later-button" type="submit" onclick={click}
            >Later default</button
          >{/if}
      </form>{/if}
    {#if mode === 'external-after'}<button
        id="external-after"
        type="submit"
        form="primary-form"
        onclick={externalClick}>After owner</button
      >{/if}
    <form id="secondary-form" bind:this={other} onsubmit={secondary}><span>Second form</span></form>
  </div>
  <div class="controls">
    <button id="request" type="button" disabled={mode === 'button-bypass'} onclick={request}
      >Request</button
    ><button id="detach" type="button" onclick={detach}>Detach first</button>
  </div>
  {#if mode === 'continuous'}<button id="move-origin" type="button" onpointermove={move}
      >Continuous origin</button
    >{/if}
  <p id="phase" bind:this={rendered}>{phase}</p>
  <p id="log">{log}</p>
</main>
