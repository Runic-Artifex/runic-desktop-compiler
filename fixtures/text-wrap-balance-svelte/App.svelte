<script lang="ts">
  const samples = [
    'Balanced text is broken again when the text of the paragraph changes at run time',
    'A short sample',
    'Another sample long enough to wrap onto two lines at the narrower viewport',
  ];
  let index = $state(0);
  let on = $state(true);
</script>

<main>
  <div class="controls">
    <button id="next" onclick={() => (index = (index + 1) % samples.length)}>next sample</button>
    <button id="toggle" onclick={() => (on = !on)}>toggle balance</button>
  </div>
  <h1 id="heading" class="balance center">
    Balanced headings avoid a lonely last <span id="heading-last">word</span>
  </h1>
  <p id="fox" class="balance">
    The quick brown fox jumps over the lazy dog and keeps running far away from the
    <span id="fox-last">farmer</span>
  </p>
  <p id="bisect" class="balance bisect">
    Internationalization standardization <span id="bisect-last">procedures</span>
  </p>
  <p id="one" class="balance">Balanced text that fits stays on one line</p>
  <p id="justify" class="balance justify">
    Justified balanced text has no line penalty, so its lines are scored on their slack alone
    and <span id="justify-last">justified</span>
  </p>
  <p id="indent" class="balance indent">
    An indented first line narrows the width it is balanced against, and the others
    <span id="indent-last">follow</span>
  </p>
  <p id="forced" class="balance pre-line">The paragraph before a forced break is balanced on its own
and the one after it is broken greedily as <span id="forced-last">usual</span></p>
  <p id="inline" class="balance">
    Text with <b>bold words</b>, <span class="big">larger letters</span> and
    <span class="boxed">a padded box</span> is balanced across its inline
    <span id="inline-last">elements</span>
  </p>
  <p id="longhand" class="longhand tight">
    The text-wrap-style longhand balances too, here with tightened letter
    <span id="longhand-last">spacing</span>
  </p>
  <p id="span-only">
    The paragraph's style counts: a <span class="balance" id="span-balance"
      >balancing span in a greedy paragraph</span
    > changes nothing
  </p>
  <p id="dynamic" class={on ? 'balance' : ''}>{samples[index]}</p>
</main>
