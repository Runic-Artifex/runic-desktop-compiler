<script lang="ts">
  const long =
    'The quick brown fox jumps over the lazy dog while five boxing wizards jump quickly and a sphinx of black quartz judges every vow.';
  const short = 'Shorter than its clamp.';
  let text = $state(long);
  let narrow = $state(false);
</script>

<main class={narrow ? 'narrow' : ''}>
  <div class="controls">
    <button id="change" onclick={() => (text = text === long ? short : long)}>change text</button>
    <button id="resize" onclick={() => (narrow = !narrow)}>resize</button>
  </div>
  <div id="one-box" class="box">
    <p id="one" class="line-clamp-1">{text}</p>
  </div>
  <div id="two-box" class="box">
    <p id="two" class="line-clamp-2 card">{text}</p>
  </div>
  <div id="three-box" class="box">
    <p id="three" class="line-clamp-3">{text}</p>
  </div>
  <div id="short-box" class="box">
    <p id="short" class="line-clamp-3 card">{short}</p>
  </div>
  <div id="nested-box" class="box">
    <div id="nested" class="line-clamp-2 card">
      <div id="nested-title" class="item">Title of the card</div>
      <div id="nested-body" class="item">{text}</div>
      <div id="nested-after" class="item">After the clamp</div>
    </div>
  </div>
</main>
