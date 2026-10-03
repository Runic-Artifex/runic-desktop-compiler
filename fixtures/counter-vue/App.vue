<script setup>
import {ref,computed} from 'vue';
const n=ref(1);const seen=ref(0);const observed=ref(0);const show=ref(true);
const label=computed(()=>n.value);
function sequence(){const captured=n.value;n.value=2;n.value=Math.min(n.value+1,3);seen.value=captured;observed.value=n.value;}
function increment(){n.value=Math.min(n.value+1,3);}
function toggle(){show.value=!show.value;}
</script>
<template><main><h1 id="heading">Counter</h1><p id="value">{{label}}</p><p id="seen">{{seen}}</p><p id="observed">{{observed}}</p><p id="flag">{{show}}</p><button id="sequence" @click="sequence">Sequence</button><button id="increment" :disabled="n===3" @click="increment">Increment</button><button id="toggle" @click="toggle">Toggle</button><p id="details" v-if="show">Visible</p></main></template>
