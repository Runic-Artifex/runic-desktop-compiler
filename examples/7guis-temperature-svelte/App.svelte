<script lang="ts">
  let celsius = $state('');
  let fahrenheit = $state('');

  const format = (n: number): string => String(Math.round(n * 100) / 100);

  function fromCelsius(text: string) {
    celsius = text;
    const value = Number(text);
    if (text.trim() !== '' && !Number.isNaN(value)) fahrenheit = format((value * 9) / 5 + 32);
  }

  function fromFahrenheit(text: string) {
    fahrenheit = text;
    const value = Number(text);
    if (text.trim() !== '' && !Number.isNaN(value)) celsius = format(((value - 32) * 5) / 9);
  }
</script>

<main>
  <h1>Temperature Converter</h1>
  <div class="row">
    <input id="celsius" type="text" value={celsius} oninput={(e) => fromCelsius(e.currentTarget.value)} />
    <span>Celsius =</span>
    <input id="fahrenheit" type="text" value={fahrenheit} oninput={(e) => fromFahrenheit(e.currentTarget.value)} />
    <span>Fahrenheit</span>
  </div>
  <p id="status">{celsius.trim() === '' ? 'Enter a temperature' : `${celsius} °C is ${fahrenheit} °F`}</p>
</main>
