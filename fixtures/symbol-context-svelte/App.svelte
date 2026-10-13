<script lang="ts">
  import Provider from './Provider.svelte';
  import Show from './Show.svelte';
  import Probe from './Probe.svelte';
  import Other from './Other.svelte';
</script>

<main>
  <h1>Symbol context keys</h1>
  <Provider label="outer">
    <Show id="a" />
    <Provider label="inner">
      <Show id="b" />
      <Show id="c" />
    </Provider>
    <Probe id="p1" />
  </Provider>
  <Other value="other value">
    <Probe id="p2" />
    <Provider label="third">
      <Show id="d" />
      <Probe id="p3" />
    </Provider>
  </Other>
  <Probe id="p4" />
</main>
