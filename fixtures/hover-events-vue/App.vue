<script setup lang="ts">
import { ref } from 'vue';
const log = ref<string[]>([]);
const overs = ref(0);
const targets = ref<string[]>([]);
function record(event: MouseEvent) {
  targets.value.push(
    `${event.type}:${event.target.id}:${event.currentTarget!.id}:${event.relatedTarget === null ? '-' : event.relatedTarget.id}:${event.button}:${event.buttons}`,
  );
  if (targets.value.length > 14) targets.value.shift();
}
function add(entry: string) {
  log.value.push(entry);
  if (log.value.length > 14) log.value.shift();
}
const names = ['a', 'b', 'c'];
</script>

<template>
  <main>
    <h1>Hover events</h1>
    <ul
      id="list"
      @pointerover="record"
      @pointerout="record"
      @mouseover="
        overs++;
        record($event);
      "
      @mouseout="
        add('list:out');
        record($event);
      "
    >
      <li
        v-for="name in names"
        :key="name"
        :id="`item-${name}`"
        @pointerover="
          add(`${name}:pover`);
          record($event);
        "
        @pointerout="
          add(`${name}:pout`);
          record($event);
        "
        @mouseover="
          add(`${name}:over`);
          record($event);
        "
        @mouseout="
          add(`${name}:out`);
          record($event);
        "
        @mouseenter="add(`${name}:enter`)"
      >
        <span :id="`label-${name}`">{{ name }}</span>
      </li>
    </ul>
    <p id="title" @pointerover="record" @pointerout="record" @mouseover="record" @mouseout="record">
      Outside the list
    </p>
    <p
      id="direct"
      @pointerover="record"
      @pointerout="record"
      @mouseover="record"
      @mouseout="record"
    >
      Direct {{ names[0] }} target text
    </p>
    <p id="overs">{{ overs }}</p>
    <p id="log">{{ log.join(' ') }}</p>
    <p id="boundary-log">{{ targets.join(' ') }}</p>
  </main>
</template>
