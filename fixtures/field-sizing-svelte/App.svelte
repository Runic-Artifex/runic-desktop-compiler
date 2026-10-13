<script lang="ts">
  let fixed = $state(false);
  let wide = $state('The quick brown fox jumps over the lazy dog');
  let limited = $state('one\ntwo\nthree\nfour');
  let tall = $state('abc');
  let toggled = $state('Sized by its text');
</script>

<main>
  <div class="controls">
    <button id="toggle" onclick={() => (fixed = !fixed)}>toggle sizing</button>
  </div>
  <p id="name-row" class="row">
    Name <input id="name" class="content limits" placeholder="Name" />
    <span id="name-after">after</span>
  </p>
  <p id="email-row" class="row flex">
    <span class="label">Email</span><input id="email" type="email" class="content" value="ada@example.org" />
    <span id="email-after">after</span>
  </p>
  <div id="notes-box" class="box">
    <textarea id="notes" class="content"></textarea><span id="notes-after">after</span>
  </div>
  <div id="message-box" class="box">
    <textarea
      id="message"
      class="content message"
      placeholder="Type your message here. It wraps at the width of the box."
    ></textarea>
  </div>
  <div id="wide-box" class="box">
    <textarea
      id="wide"
      class="content narrow"
      rows="6"
      cols="40"
      bind:value={wide}
    ></textarea>
  </div>
  <div id="limited-box" class="box">
    <textarea id="limited" class="content short" bind:value={limited}></textarea>
    <textarea id="tall" class="content tall" bind:value={tall}></textarea>
  </div>
  <div id="toggled-box" class="box">
    <textarea id="toggled" class={fixed ? 'fixed' : 'content'} bind:value={toggled}></textarea>
  </div>
</main>
