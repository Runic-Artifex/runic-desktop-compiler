import { useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

export function App() {
  const form = useRef<HTMLElement | null>(null);
  const other = useRef<HTMLElement | null>(null);
  const detached = useRef<HTMLElement | null>(null);
  const rendered = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState('physical');
  const [log, setLog] = useState('ready');
  const [show, setShow] = useState(true);
  const [phase, setPhase] = useState('idle');

  function note(s: string) {
    setLog(l => (l === 'ready' ? s : l + ' ' + s).slice(-512));
  }
  function select(s: string) {
    setMode(s);
    setLog('ready');
    setShow(true);
    setPhase('idle');
    detached.current = null;
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
  function submit(e: FormEvent) {
    e.preventDefault();
    // The retained React async-listener guard rejects currentTarget even before
    // queueMicrotask. This bound form ref checks the submit target synchronously.
    note(`submit:${e.type}:${e.target === form.current}:${e.defaultPrevented}`);
    setPhase('submitted');
    if (mode === 'continuous') {
      queueMicrotask(() => note(`micro:${rendered.current?.textContent}`));
    }
    if (mode === 'recursive') {
      note('inner-before');
      form.current?.requestSubmit();
      note('inner-after');
    }
    if (mode === 'cross') {
      note('cross-before');
      other.current?.requestSubmit();
      note('cross-after');
    }
    if (mode === 'remove') {
      detached.current = form.current;
      setShow(false);
      note('removed');
    }
  }
  function secondary(e: FormEvent) {
    e.preventDefault();
    note('secondary');
  }
  function detach() {
    detached.current = form.current;
    setShow(false);
    note('detached');
  }
  function request() {
    if (mode === 'timer') {
      setTimeout(() => {
        setPhase('origin');
        note('timer-before');
        form.current?.requestSubmit();
        note('timer-after');
        queueMicrotask(() => note(`micro:${rendered.current?.textContent}`));
      }, 0);
      return;
    }
    note('before');
    const receiver =
      mode === 'detached' || mode === 'remove' ? detached.current || form.current : form.current;
    receiver?.requestSubmit();
    if (mode === 'sequential') {
      note('between');
      receiver?.requestSubmit();
    }
    note('after');
  }
  function move() {
    setPhase('origin');
    note('move-before');
    form.current?.requestSubmit();
    note('move-after');
  }

  return (
    <main>
      <h1>Form submission</h1>
      <div className="modes">
        <button id="mode-physical" type="button" onClick={() => select('physical')}>
          {' '}
          physical{' '}
        </button>
        <button id="mode-cancel" type="button" onClick={() => select('cancel')}>
          {' '}
          cancel{' '}
        </button>
        <button id="mode-implicit" type="button" onClick={() => select('implicit')}>
          {' '}
          implicit{' '}
        </button>
        <button id="mode-cancel-implicit" type="button" onClick={() => select('cancel-implicit')}>
          {' '}
          cancel-implicit{' '}
        </button>
        <button id="mode-disabled" type="button" onClick={() => select('disabled')}>
          {' '}
          disabled{' '}
        </button>
        <button id="mode-one" type="button" onClick={() => select('one')}>
          {' '}
          one{' '}
        </button>
        <button id="mode-two" type="button" onClick={() => select('two')}>
          {' '}
          two{' '}
        </button>
        <button id="mode-two-disabled" type="button" onClick={() => select('two-disabled')}>
          {' '}
          two-disabled{' '}
        </button>
        <button id="mode-external-before" type="button" onClick={() => select('external-before')}>
          {' '}
          external-before{' '}
        </button>
        <button id="mode-external-after" type="button" onClick={() => select('external-after')}>
          {' '}
          external-after{' '}
        </button>
        <button id="mode-invalid" type="button" onClick={() => select('invalid')}>
          {' '}
          invalid{' '}
        </button>
        <button id="mode-duplicate" type="button" onClick={() => select('duplicate')}>
          {' '}
          duplicate{' '}
        </button>
        <button id="mode-novalidate" type="button" onClick={() => select('novalidate')}>
          {' '}
          novalidate{' '}
        </button>
        <button id="mode-button-bypass" type="button" onClick={() => select('button-bypass')}>
          {' '}
          button-bypass{' '}
        </button>
        <button id="mode-search" type="button" onClick={() => select('search')}>
          {' '}
          search{' '}
        </button>
        <button id="mode-tel" type="button" onClick={() => select('tel')}>
          {' '}
          tel{' '}
        </button>
        <button id="mode-password" type="button" onClick={() => select('password')}>
          {' '}
          password{' '}
        </button>
        <button id="mode-missing-type" type="button" onClick={() => select('missing-type')}>
          {' '}
          missing-type{' '}
        </button>
        <button id="mode-invalid-type" type="button" onClick={() => select('invalid-type')}>
          {' '}
          invalid-type{' '}
        </button>
        <button id="mode-request" type="button" onClick={() => select('request')}>
          {' '}
          request{' '}
        </button>
        <button id="mode-sequential" type="button" onClick={() => select('sequential')}>
          {' '}
          sequential{' '}
        </button>
        <button id="mode-recursive" type="button" onClick={() => select('recursive')}>
          {' '}
          recursive{' '}
        </button>
        <button id="mode-cross" type="button" onClick={() => select('cross')}>
          {' '}
          cross{' '}
        </button>
        <button id="mode-detached" type="button" onClick={() => select('detached')}>
          {' '}
          detached{' '}
        </button>
        <button id="mode-remove" type="button" onClick={() => select('remove')}>
          {' '}
          remove{' '}
        </button>
        <button id="mode-timer" type="button" onClick={() => select('timer')}>
          {' '}
          timer{' '}
        </button>
        <button id="mode-continuous" type="button" onClick={() => select('continuous')}>
          {' '}
          continuous{' '}
        </button>
        <button id="mode-capture" type="button" onClick={() => select('capture')}>
          {' '}
          capture{' '}
        </button>
      </div>
      <p id="mode">{mode}</p>
      <div className="arena">
        {mode === 'duplicate' && <div id="duplicate-owner">First matching ID is not a form</div>}
        {mode === 'external-before' && (
          <button id="external-before" type="submit" form="primary-form" onClick={externalClick}>
            Before owner
          </button>
        )}
        {show && (
          <form
            id={mode === 'duplicate' ? 'duplicate-owner' : 'primary-form'}
            ref={form}
            noValidate={mode === 'novalidate'}
            onSubmit={submit}
          >
            <input
              id="field"
              aria-label="Submission field"
              type={
                mode === 'search'
                  ? 'search'
                  : mode === 'tel'
                    ? 'tel'
                    : mode === 'password'
                      ? 'password'
                      : mode === 'missing-type'
                        ? undefined
                        : mode === 'invalid-type'
                          ? 'not-a-type'
                          : 'text'
              }
              required={mode === 'novalidate' || mode === 'button-bypass'}
            />
            {(mode === 'two' || mode === 'two-disabled') && (
              <input
                id="blocker"
                aria-label="Extra blocker"
                type="text"
                disabled={mode === 'two-disabled'}
              />
            )}
            {mode !== 'one' &&
              mode !== 'two' &&
              mode !== 'two-disabled' &&
              mode !== 'external-after' && (
                <button
                  id="submit-button"
                  type="submit"
                  form={
                    mode === 'invalid'
                      ? 'missing-owner'
                      : mode === 'duplicate'
                        ? 'duplicate-owner'
                        : 'primary-form'
                  }
                  disabled={mode === 'disabled'}
                  formNoValidate={mode === 'button-bypass'}
                  onClick={click}
                >
                  <span id="submit-child">Nested submit</span>
                </button>
              )}
            {mode === 'disabled' && (
              <button id="later-button" type="submit" onClick={click}>
                Later default
              </button>
            )}
          </form>
        )}
        {mode === 'external-after' && (
          <button id="external-after" type="submit" form="primary-form" onClick={externalClick}>
            After owner
          </button>
        )}
        <form id="secondary-form" ref={other} onSubmit={secondary}>
          <span>Second form</span>
        </form>
      </div>
      <div className="controls">
        <button id="request" type="button" disabled={mode === 'button-bypass'} onClick={request}>
          Request
        </button>
        <button id="detach" type="button" onClick={detach}>
          Detach first
        </button>
      </div>
      {mode === 'continuous' && (
        <button id="move-origin" type="button" onPointerMove={move}>
          Continuous origin
        </button>
      )}
      <p id="phase" ref={rendered}>
        {phase}
      </p>
      <p id="log">{log}</p>
    </main>
  );
}
