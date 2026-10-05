<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  currencyNames,
  localeName,
  nth,
  plural,
  pluralCategories,
  regionNames,
  scriptNames,
  standardNames,
} from './intl.ts';

const TARGETS = ['en', 'de-AT', 'pl', 'ar', 'pt-PT', 'pt-BR', 'fr-CA', 'zh-Hant-TW', 'cy', 'sr-Latn', 'iw', 'tlh', 'en_US'];
const UI = ['en', 'de', 'fr-FR', 'en-GB'];
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 22, 23, 101, 1.5, 0.0005, 1000000];

const target = ref(0);
const ui = ref(0);
const ordinal = ref(false);
const locale = computed(() => TARGETS[target.value]);
const uiLocale = computed(() => UI[ui.value]);
const categories = computed(() => pluralCategories(locale.value, ordinal.value).join(', '));
const selected = computed(() =>
  COUNTS.map(n => `${n}: ${plural(locale.value, ordinal.value, n)}`).join(' · '),
);
const names = computed(() => TARGETS.map(t => `${t}: ${localeName(t, uiLocale.value)}`));
const ordinals = COUNTS.slice(0, 10).map(nth).join(' ');
const regions = regionNames(['US', 'GB', 'CD', '419', 'DE', 'XK', 'ZZ', '001', 'us']);
const scripts = scriptNames(['Latn', 'Cyrl', 'Hans', 'Hrkt', 'Zzzz', 'Qaaa']);
const standard = standardNames(['en-US', 'zh-Hans', 'sr-Latn-RS', 'xx-CD', 'de-AT']);
const currencies = computed(() => currencyNames(['EUR', 'usd', 'JPY', 'CHF', 'XAU'], uiLocale.value));

function next() {
  target.value = (target.value + 1) % TARGETS.length;
}
function toggle() {
  ordinal.value = !ordinal.value;
}
function nextUi() {
  ui.value = (ui.value + 1) % UI.length;
}
</script>

<template>
  <main>
    <p id="target">{{ locale }} · {{ localeName(locale, uiLocale) }} · {{ ordinal ? 'ordinal' : 'cardinal' }}</p>
    <p id="categories">{{ categories }}</p>
    <p id="select">{{ selected }}</p>
    <ul id="names">
      <li v-for="n in names" :key="n">{{ n }}</li>
    </ul>
    <p id="nth">{{ ordinals }}</p>
    <p id="regions">{{ regions }}</p>
    <p id="scripts">{{ scripts }}</p>
    <p id="standard">{{ standard }}</p>
    <p id="currencies">{{ currencies }}</p>
    <div class="row">
      <button id="next" @click="next">Next locale</button>
      <button id="ordinal" @click="toggle">Ordinal</button>
      <button id="ui" @click="nextUi">{{ uiLocale }}</button>
    </div>
  </main>
</template>
