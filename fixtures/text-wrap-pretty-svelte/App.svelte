<script lang="ts">
  const samples = [
    'Pretty text is broken again when the text of the paragraph changes at run time, so the new lines are scored again and the end',
    'A short sample',
    'Another sample long enough to wrap onto a few lines at the narrower viewport and at the wider one also keeps a lonely word off its last line pretty',
  ];
  let index = $state(0);
  let on = $state(true);
</script>

<main>
  <div class="controls">
    <button id="next" onclick={() => (index = (index + 1) % samples.length)}>next sample</button>
    <button id="toggle" onclick={() => (on = !on)}>toggle pretty</button>
  </div>
  <h1 id="heading" class="pretty center">
    Pretty headings keep a single short word off the end of their own final line and move one
    more word down to join it on the last <span id="heading-last">line</span>
  </h1>
  <p id="fox" class="pretty">
    The quick brown fox jumps over the lazy dog and keeps running far away from the farmer who
    chases it across the green fields and over the hills until the sun goes down behind the old
    red <span id="fox-last">barn</span>
  </p>
  <p id="long" class="pretty">
    Chromium optimizes only the last four lines of a paragraph when it lays out text with pretty
    wrapping, so the earlier lines of this rather long paragraph keep the breaks that greedy line
    breaking gives them, and only the lines near the end move to keep a single word off the very
    last line of the whole paragraph as it does for every <span id="long-last">one</span>
  </p>
  <p id="one" class="pretty">Pretty text that fits stays on one line</p>
  <p id="justify" class="pretty justify">
    Justified pretty text has no line penalty, so its lines are scored on their slack alone, and
    the last line still takes more than a single short word even though the other lines are
    stretched to <span id="justify-last">width</span>
  </p>
  <p id="indent" class="pretty indent">
    An indented first line narrows the width it is scored against, and the lines that follow it
    are broken to keep the last one from <span id="indent-last">ending</span>
  </p>
  <p id="forced" class="pretty pre-line">Each paragraph before a forced break is broken on its own, like this list of apples, pears, plums, figs, limes, kiwis, dates, and nuts
and the one after it keeps a single word off its last line too, as it lists apples, pears, plums, and <span id="forced-last">nuts</span></p>
  <p id="preserved" class="pretty pre-wrap">Preserved  spaces  wrap  as  well,  and  pretty  wrapping  still  keeps  a  lonely  word  off  the  end  of  the  last  line  of  this  <span id="preserved-last">text</span></p>
  <p id="inline" class="pretty">
    Text with <b>bold words</b>, <span class="big">larger letters</span> and
    <span class="boxed">a padded box</span> is broken prettily across its inline
    <span id="inline-last">elements</span>
  </p>
  <p id="longhand" class="longhand tight">
    The text-wrap-style longhand selects pretty wrapping too, here with tightened letter spacing
    in a list of apples, pears, plums, figs, limes, kiwis, and <span id="longhand-last">nuts</span>
  </p>
  <p id="narrow" class="pretty narrow">
    A last line of a third of the width or more keeps its greedy <span id="narrow-last">breaks</span>
  </p>
  <p id="span-only">
    The paragraph's style counts: a <span class="pretty" id="span-pretty"
      >pretty span in a greedy paragraph</span
    > changes nothing in this list of apples, pears, plums, figs, limes, kiwis, dates, grapes,
    melons, cherries, lemons, and <span id="span-last">nuts</span>
  </p>
  <p id="dynamic" class={on ? 'pretty' : ''}>{samples[index]}</p>
</main>
