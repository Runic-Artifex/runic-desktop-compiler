<script setup lang="ts">
import {
  ref,
  watch,
  watchEffect,
  onBeforeMount,
  onMounted,
  onBeforeUnmount,
  onUnmounted,
} from 'vue';
import Panel from './Panel.vue';
const count = ref(0);
const show = ref(true);
const shown = ref('');
const log: string[] = [];
function note(s: string) {
  log.push(s);
}
function dump() {
  shown.value = log.join(' | ');
  log.splice(0, log.length);
}
onBeforeMount(() => note(`App before mount ${count.value}`));
watchEffect(onCleanup => {
  note(`App pre ${count.value}`);
  onCleanup(() => note(`App pre cleanup ${count.value}`));
});
watch(count, (value, old) => {
  note(`App watch ${value} ${old}`);
});
watch([() => show.value, count], ([visible, c], [wasVisible]) => {
  note(`App shown ${visible} ${c} ${wasVisible}`);
});
onMounted(() => note('App mount'));
onBeforeUnmount(() => note('App before unmount'));
onUnmounted(() => note('App unmount'));
</script>

<template>
  <main>
    <h1 id="title">Effects</h1>
    <Panel v-if="show" :count="count" :note="note" />
    <p id="log">{{ shown }}</p>
    <div class="controls"><button id="inc" @click="count++">Increment</button><button id="toggle" @click="show = !show">Toggle</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
