<script lang="ts">
  // Dates, times and numbers as the Translations Editor shows them (recent
  // projects with their opening date in the UI locale, byte counts, sorted
  // keys), plus a ticking clock and the Date API around a DST transition.
  const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const euros = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const keys = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const UI_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'en-GB'];

  let now = $state(new Date());
  let opened = $state(new Date('2026-03-29T01:30:00Z'));
  let bytes = $state(1234567);
  let ratio = $state(0.256);
  let uiLocale = $state('en-US');
  let typed = $state('2026-07-04T12:00');
  let names = $state(['item 10', 'Émile', 'zoë', 'Zoe', 'adam', 'item 2', 'Ärger', 'Adam']);

  const parsed = $derived(new Date(typed));
  const sorted = $derived(names.toSorted(keys.compare));
  const plain = $derived([...names].sort((a, b) => a.localeCompare(b)));
  const elapsed = $derived(Math.round((now.getTime() - opened.getTime()) / 86400000));

  $effect(() => {
    const id = setInterval(() => {
      now = new Date();
    }, 1000);
    return () => clearInterval(id);
  });

  function nextDay() {
    const d = new Date(opened);
    d.setDate(d.getDate() + 1);
    opened = d;
  }
  function lateEvening() {
    const d = new Date(opened.getTime());
    d.setHours(23, 59, 59, 999);
    opened = d;
  }
  function nextLocale() {
    uiLocale = UI_LOCALES[(UI_LOCALES.indexOf(uiLocale) + 1) % UI_LOCALES.length];
  }
</script>

<main>
  <p id="now"><span class="label">now</span> {now.toISOString()} · {clock.format(now)}</p>
  <p id="string">{now.toString()}</p>
  <p id="local">{now.toLocaleString()} · {now.toLocaleDateString(uiLocale)} · {now.toLocaleTimeString(uiLocale)}</p>
  <p id="opened">
    {opened.toLocaleDateString(uiLocale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
    {opened.toLocaleTimeString(uiLocale, { hour: 'numeric', minute: '2-digit' })}
  </p>
  <p id="stamp">{stamp.format(opened)}</p>
  <p id="fields">
    {opened.getFullYear()}-{opened.getMonth() + 1}-{opened.getDate()} {opened.getHours()}:{opened.getMinutes()}
    offset {opened.getTimezoneOffset()} · {opened.toUTCString()} · {elapsed} days
  </p>
  <p id="numbers">
    {bytes.toLocaleString()} bytes · {bytes.toLocaleString(uiLocale)} · {euros.format(bytes / 100)} ·
    {ratio.toLocaleString(uiLocale, { style: 'percent', minimumFractionDigits: 1 })}
  </p>
  <p id="parsed">{Number.isNaN(parsed.getTime()) ? 'Invalid Date' : parsed.toISOString()} · {parsed.toDateString()}</p>
  <ul id="sorted">
    {#each sorted as name}<li>{name}</li>{/each}
  </ul>
  <p id="plain">{plain.join(', ')}</p>
  <div class="row">
    <button id="next" onclick={nextDay}>Next day</button>
    <button id="late" onclick={lateEvening}>23:59</button>
    <button id="locale" onclick={nextLocale}>{uiLocale}</button>
    <button id="more" onclick={() => { bytes = bytes * 7 + 3; ratio = ratio / 3; }}>More</button>
  </div>
  <div class="row"><input id="when" type="text" bind:value={typed} /></div>
</main>
