<script lang="ts">
  const samples = ['über-straße ǆungla', 'hello world', "it's the 3rd e.g. x2y"];
  let index = $state(0);
  let on = $state(true);
  let side = $state('top');
</script>

<main>
  <h1 id="title" class="cap">text-transform: capitalize</h1>
  <p class="cap"><span id="boundaries">hello world foo-bar (paren) «guill» don't it’s rock'n'roll 3rd x2y 1-a e.g. a:b a/b x_y</span></p>
  <p class="cap"><span id="cases">HELLO wORLD mIxEd McDONALD élan straße ßtraße ǆemal ǉubav ǌoj ﬁsh</span></p>
  <p class="cap"><span id="scripts">αβγ ἀρχή σοφία ΐa абв ձա ıi ᾳ ჰა</span></p>
  <p class="cap"><span id="split"><b>a</b>bc ab<i>c d</i>e foo <b>bar</b> don'<b>t</b> don<b>'t</b> a<b>.</b>b</span></p>
  <p class="cap"><span id="lines">abc<br />def ghi</span></p>
  <p class="cap narrow" id="wrap">aaa bbb-ccc ddd eee</p>
  <p class="cap"><span id="boxes">abc<span class="ib">x</span>def abc<span class="ib"></span>def ab<span class="ib">x </span>cd ab<span class="abs"></span>cd</span></p>
  <p><span id="boxes-control">Abc<span class="ib">X</span>def Abc<span class="ib"></span>Def Ab<span class="ib">X </span>cd Ab<span class="abs"></span>cd</span></p>
  <p class="cap"><span id="spaces">a&nbsp;b c&nbsp;&nbsp;d e<span class="fl"></span>f</span></p>
  <p class="cap" id="after-abs"><span class="abs" id="abs-x">x</span> <b id="after-abs-b">cd</b> ef</p>
  <p class="cap"><span id="styles"><span class="none">ab</span>cd <span class="none">ef </span>gh <span class="upper">ij</span>kl</span></p>
  <p class="cap"><span id="dynamic">{samples[index]}</span> <span id="side">{side}</span></p>
  <p class={on ? 'cap' : ''}><span id="toggled">toggled words here</span></p>
  <div class="controls">
    <button id="next" class="cap" onclick={() => (index = (index + 1) % samples.length)}>next sample</button>
    <button id="toggle" onclick={() => (on = !on)}>toggle</button>
    <button id="side-button" class="cap" onclick={() => (side = side === 'top' ? 'bottom' : 'top')}>
      {side}
    </button>
  </div>
</main>
