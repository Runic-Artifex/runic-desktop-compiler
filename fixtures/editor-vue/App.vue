<script setup lang="ts">
import {ref,computed} from 'vue';
const text=ref('');const locked=ref(false);const readonly=ref(false);const show=ref(true);
const length=computed(()=>text.value.length);
function input(event){text.value=event.target.value;}
function clear(){text.value='';}
function lock(){locked.value=!locked.value;}
function readOnly(){readonly.value=!readonly.value;}
function toggle(){show.value=!show.value;}
</script>
<template><main><h1 id="heading">Native text editor</h1><input id="editor" aria-label="Text" type="text" maxlength="256" :value="text" :disabled="locked" :readonly="readonly" @input="input"/><p id="preview">{{text}}</p><p id="count">{{length}}</p><button id="clear" :disabled="text===''" @click="clear">Clear</button><button id="lock" @click="lock">Lock</button><button id="readonly" @click="readOnly">Read only</button><button id="toggle" @click="toggle">Toggle details</button><p id="details" v-if="show">Stable editor identity</p></main></template>
