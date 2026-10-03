<script setup lang="ts">
import {ref,computed} from 'vue';
import {advance as next, amount, ceiling, starting, heading} from './logic.ts';
const n=ref(starting);
const seen=ref(0);
const show=ref(true);
const initial=n.value;
const label=computed(()=>n.value);
function increment(){n.value=next(n.value,amount,ceiling);}
function sequence(){const before=n.value;n.value=next(n.value,amount,ceiling);seen.value=before;}
function reset(){n.value=starting;seen.value=starting;}
function toggle(){show.value=!show.value;}
</script>
<template><main><h1 id="heading">{{heading}}</h1><p id="value">{{label}}</p><p id="seen">{{seen}}</p><p id="initial">{{initial}}</p><p id="flag">{{show}}</p><div class="controls"><button id="increment" :disabled="n===ceiling" @click="increment">Increment</button><button id="sequence" @click="sequence">Sequence</button><button id="reset" @click="reset">Reset</button><button id="toggle" @click="toggle">Toggle</button></div><p id="details" v-if="show">Visible</p></main></template>
