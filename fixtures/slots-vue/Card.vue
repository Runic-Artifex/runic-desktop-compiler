<script setup lang="ts">
const { title } = defineProps<{ title: string }>();
defineSlots<{ default(): any; header?(props: { title: string }): any }>();
</script>
<template>
<section :id="`card-${title}`"><h2><slot name="header" :title="title"><span :id="`header-${title}`">{{ title }}</span></slot></h2><slot /></section>
</template>
