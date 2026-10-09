<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
const form = ref<HTMLElement | null>(null);
const other = ref<HTMLElement | null>(null);
const detached = ref<HTMLElement | null>(null);
const rendered = ref<HTMLElement | null>(null);
const mode = ref('physical');
const log = ref('ready');
const show = ref(true);
const phase = ref('idle');
const armed = ref(false);
const fieldType = computed(() =>
  mode.value === 'search'
    ? 'search'
    : mode.value === 'tel'
      ? 'tel'
      : mode.value === 'password'
        ? 'password'
        : mode.value === 'missing-type'
          ? undefined
          : mode.value === 'invalid-type'
            ? 'not-a-type'
            : 'text',
);
const buttonOwner = computed(() =>
  mode.value === 'invalid'
    ? 'missing-owner'
    : mode.value === 'duplicate'
      ? 'duplicate-owner'
      : 'primary-form',
);
const hasButton = computed(
  () =>
    mode.value !== 'one' &&
    mode.value !== 'two' &&
    mode.value !== 'two-disabled' &&
    mode.value !== 'external-after',
);
function note(s: string) {
  log.value = (log.value === 'ready' ? s : log.value + ' ' + s).slice(-512);
}
function select(s: string) {
  mode.value = s;
  log.value = 'ready';
  show.value = true;
  phase.value = 'idle';
  armed.value = s === 'continuous';
  detached.value = null;
}
function click(e: MouseEvent) {
  note(`click:${e.detail}:${e.target === e.currentTarget}`);
  if (mode.value === 'cancel' || mode.value === 'cancel-implicit') {
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
  phase.value = 'submitted';
  if (mode.value === 'recursive') {
    note('inner-before');
    form.value?.requestSubmit();
    note('inner-after');
  }
  if (mode.value === 'cross') {
    note('cross-before');
    other.value?.requestSubmit();
    note('cross-after');
  }
  if (mode.value === 'remove') {
    detached.value = form.value;
    show.value = false;
    note('removed');
  }
}
function secondary(e: Event) {
  e.preventDefault();
  note('secondary');
}
function capture(e: Event) {
  if (mode.value !== 'capture') return;
  if (e.target === form.value) {
    note('capture-before');
    other.value?.requestSubmit();
    note('capture-after');
  } else {
    note('capture-secondary');
  }
}
function detach() {
  detached.value = form.value;
  show.value = false;
  note('detached');
}
function request() {
  if (mode.value === 'timer') {
    setTimeout(() => {
      phase.value = 'origin';
      note('timer-before');
      form.value?.requestSubmit();
      note('timer-after');
      queueMicrotask(() => note(`micro:${rendered.value?.textContent}`));
    }, 0);
    return;
  }
  note('before');
  const receiver =
    mode.value === 'detached' || mode.value === 'remove'
      ? detached.value || form.value
      : form.value;
  receiver?.requestSubmit();
  if (mode.value === 'sequential') {
    note('between');
    receiver?.requestSubmit();
  }
  note('after');
}
function move() {
  if (mode.value !== 'continuous' || !armed.value) return;
  armed.value = false;
  phase.value = 'origin';
  note('move-before');
  form.value?.requestSubmit();
  note('move-after');
  queueMicrotask(() => note(`micro:${rendered.value?.textContent}`));
}
onMounted(() => document.addEventListener('submit', capture, true));
onUnmounted(() => document.removeEventListener('submit', capture, true));
</script>
<template>
  <main>
    <h1>Form submission</h1>
    <div class="modes">
      <button id="mode-physical" type="button" @click="select('physical')">physical</button>
      <button id="mode-cancel" type="button" @click="select('cancel')">cancel</button>
      <button id="mode-implicit" type="button" @click="select('implicit')">implicit</button>
      <button id="mode-cancel-implicit" type="button" @click="select('cancel-implicit')">
        cancel-implicit
      </button>
      <button id="mode-disabled" type="button" @click="select('disabled')">disabled</button>
      <button id="mode-one" type="button" @click="select('one')">one</button>
      <button id="mode-two" type="button" @click="select('two')">two</button>
      <button id="mode-two-disabled" type="button" @click="select('two-disabled')">
        two-disabled
      </button>
      <button id="mode-external-before" type="button" @click="select('external-before')">
        external-before
      </button>
      <button id="mode-external-after" type="button" @click="select('external-after')">
        external-after
      </button>
      <button id="mode-invalid" type="button" @click="select('invalid')">invalid</button>
      <button id="mode-duplicate" type="button" @click="select('duplicate')">duplicate</button>
      <button id="mode-novalidate" type="button" @click="select('novalidate')">novalidate</button>
      <button id="mode-button-bypass" type="button" @click="select('button-bypass')">
        button-bypass
      </button>
      <button id="mode-search" type="button" @click="select('search')">search</button>
      <button id="mode-tel" type="button" @click="select('tel')">tel</button>
      <button id="mode-password" type="button" @click="select('password')">password</button>
      <button id="mode-missing-type" type="button" @click="select('missing-type')">
        missing-type
      </button>
      <button id="mode-invalid-type" type="button" @click="select('invalid-type')">
        invalid-type
      </button>
      <button id="mode-request" type="button" @click="select('request')">request</button>
      <button id="mode-sequential" type="button" @click="select('sequential')">sequential</button>
      <button id="mode-recursive" type="button" @click="select('recursive')">recursive</button>
      <button id="mode-cross" type="button" @click="select('cross')">cross</button>
      <button id="mode-detached" type="button" @click="select('detached')">detached</button>
      <button id="mode-remove" type="button" @click="select('remove')">remove</button>
      <button id="mode-timer" type="button" @click="select('timer')">timer</button>
      <button id="mode-continuous" type="button" @click="select('continuous')">continuous</button>
      <button id="mode-capture" type="button" @click="select('capture')">capture</button>
    </div>
    <p id="mode">{{ mode }}</p>
    <div class="arena">
      <div v-if="mode === 'duplicate'" id="duplicate-owner">First matching ID is not a form</div>
      <button
        v-if="mode === 'external-before'"
        id="external-before"
        type="submit"
        form="primary-form"
        @click="externalClick"
      >
        Before owner
      </button>
      <form
        v-if="show"
        :id="mode === 'duplicate' ? 'duplicate-owner' : 'primary-form'"
        ref="form"
        :novalidate="mode === 'novalidate'"
        @submit="submit"
      >
        <input
          id="field"
          aria-label="Submission field"
          :type="fieldType"
          :required="mode === 'novalidate' || mode === 'button-bypass'"
        />
        <input
          v-if="mode === 'two' || mode === 'two-disabled'"
          id="blocker"
          aria-label="Extra blocker"
          type="text"
          :disabled="mode === 'two-disabled'"
        />
        <button
          v-if="hasButton"
          id="submit-button"
          type="submit"
          :form="buttonOwner"
          :disabled="mode === 'disabled'"
          :formnovalidate="mode === 'button-bypass'"
          @click="click"
        >
          <span id="submit-child">Nested submit</span>
        </button>
        <button v-if="mode === 'disabled'" id="later-button" type="submit" @click="click">
          Later default
        </button>
      </form>
      <button
        v-if="mode === 'external-after'"
        id="external-after"
        type="submit"
        form="primary-form"
        @click="externalClick"
      >
        After owner
      </button>
      <form id="secondary-form" ref="other" @submit="secondary"><span>Second form</span></form>
    </div>
    <div class="controls">
      <button id="request" type="button" :disabled="mode === 'button-bypass'" @click="request">
        Request</button
      ><button id="detach" type="button" @click="detach">Detach first</button>
    </div>
    <button v-if="mode === 'continuous'" id="move-origin" type="button" @pointermove="move">
      Continuous origin
    </button>
    <p id="phase" ref="rendered">{{ phase }}</p>
    <p id="log">{{ log }}</p>
  </main>
</template>
