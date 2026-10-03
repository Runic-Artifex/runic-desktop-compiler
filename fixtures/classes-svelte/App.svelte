<script lang="ts">
  let on = $state(false);
  let other = $state(true);
  let base = $state('card  wide');
</script>

<main>
  <div class="row">
    <button id="toggle" onclick={() => (on = !on)}>Toggle</button>
    <button id="other" onclick={() => (other = !other)}>Other</button>
    <button id="base" onclick={() => (base = base === 'card  wide' ? 'card on' : 'card  wide')}>Base</button>
  </div>
  <p id="bare" class:on>Bare</p>
  <p id="fixed" class="fixed  text" class:on class:off={!on}>Fixed</p>
  <p id="dynamic" class={base} class:on class:other>Dynamic</p>
</main>
