<script lang="ts">
  let comment = $state('');
  let query = $state('');
  let tall = $state(false);
  let fixed = $state('Two rows');
</script>

<main>
  <div class="controls">
    <button id="toggle" onclick={() => (tall = !tall)}>toggle min-height</button>
  </div>
  <!-- shadcn's input group with a text area and a block-end addon -->
  <div id="comment-group" class="group">
    <textarea
      id="comment"
      class="grow area content"
      class:tall
      placeholder="Write a comment..."
      bind:value={comment}
    ></textarea>
    <div class="addon"><span id="count">{comment.length}/280</span><button>Post</button></div>
  </div>
  <!-- input groups with a block-end and a block-start addon -->
  <div id="end-group" class="group">
    <input id="query" class="grow field end" placeholder="Search..." bind:value={query} />
    <div class="addon"><span>{query.length} results</span></div>
  </div>
  <div id="start-group" class="group">
    <div class="addon"><span>Full name</span></div>
    <input id="name" class="grow field start" placeholder="Ada Lovelace" />
  </div>
  <!-- a fixed-size text area with an automatic flex basis -->
  <div id="fixed-group" class="group">
    <textarea id="fixed" class="auto area" rows="2" bind:value={fixed}></textarea>
    <div class="addon"><span>fixed</span></div>
  </div>
  <!-- scroll containers: a growing one below its min-height, a growing one
       above its max-height, a rigid one above its max-height -->
  <div id="scroll-group" class="group">
    <div id="min-scroller" class="grow scroller min">Short</div>
    <div id="max-scroller" class="auto scroller max">One<br />Two<br />Three<br />Four</div>
    <div id="rigid-scroller" class="rigid scroller max">Five<br />Six<br />Seven</div>
  </div>
  <!-- an item whose flex basis is below its content, without an automatic
       minimum size: it contributes its flex basis and overflows the group -->
  <div id="basis-group" class="group plain">
    <div id="basis-item" class="basis">One<br />Two<br />Three</div>
  </div>
  <p id="after">After the groups</p>
</main>
