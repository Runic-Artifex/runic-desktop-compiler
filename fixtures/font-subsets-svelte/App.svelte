<script lang="ts">
  const samples = ['Łódź, Kraków 2024', 'Привет, мир № 7', 'Café € 12,50 † ẞ'];
  let index = $state(0);
</script>

<main>
  <div class="row">
    <input id="default" placeholder="Ada Lovelace" />
    <input id="size-1" size="1" value="0" />
    <input id="size-2" size="2" value="42" />
  </div>
  <div class="row">
    <input id="sample" value={samples[index]} />
    <button id="next" onclick={() => (index = (index + 1) % samples.length)}>next sample</button>
  </div>
  <p id="latin">Latin digits and letters 0123456789 fit the latin face</p>
  <p id="latin-ext">Latin Extended: Łódź, Śląsk, Ştefan, Đorđe, ẞ †</p>
  <p id="cyrillic">Cyrillic: Привет мир, Ґанок, Ўзбек № 5</p>
  <p id="mixed" class="semibold">Mixed 600: Zoë Łukasz Жёлтый 3 € ™</p>
  <p id="sample-text">{samples[index]}</p>
</main>
