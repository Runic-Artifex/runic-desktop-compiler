<script setup lang="ts">
import { ref } from 'vue';

const celsius = ref('');
const fahrenheit = ref('');

const format = (n: number): string => String(Math.round(n * 100) / 100);

function fromCelsius(text: string) {
  celsius.value = text;
  const value = Number(text);
  if (text.trim() !== '' && !Number.isNaN(value)) fahrenheit.value = format((value * 9) / 5 + 32);
}

function fromFahrenheit(text: string) {
  fahrenheit.value = text;
  const value = Number(text);
  if (text.trim() !== '' && !Number.isNaN(value)) celsius.value = format(((value - 32) * 5) / 9);
}
</script>

<template>
  <main>
    <h1>Temperature Converter</h1>
    <div class="row">
      <input id="celsius" type="text" :value="celsius" @input="fromCelsius($event.target.value)" />
      <span>Celsius =</span>
      <input id="fahrenheit" type="text" :value="fahrenheit" @input="fromFahrenheit($event.target.value)" />
      <span>Fahrenheit</span>
    </div>
    <p id="status">{{ celsius.trim() === '' ? 'Enter a temperature' : `${celsius} °C is ${fahrenheit} °F` }}</p>
  </main>
</template>
