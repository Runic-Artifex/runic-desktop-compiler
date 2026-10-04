<script lang="ts">
  // Regular expressions as the Translations Editor uses them: validating
  // identifiers, finding and highlighting placeholders, rewriting them with
  // a replacement function, splitting into words and reading optional
  // captures.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const PLACEHOLDER = /\{\$([\p{L}_][\p{L}\p{N}_-]*)(?:\s+:[^}]*)?\}/gu;

  let name = $state('count');
  let message = $state('Hello {$user}, you have {$count :number} new {$kind}.');

  const valid = $derived(IDENT.test(name));
  const parts = $derived(message.split(/(\{[^}]*\})/));
  const names = $derived.by(() => {
    const out: string[] = [];
    for (const m of message.matchAll(/\{\$([\p{L}_][\p{L}\p{N}_-]*)/gu)) out.push(`${m[1]}@${m.index}`);
    return out;
  });
  const preview = $derived(
    message.replace(PLACEHOLDER, (_, found: string) => (found === name ? `[${found.toUpperCase()}]` : `‹${found}›`)),
  );
  const words = $derived(new Set(message.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)).size);
  const plural = $derived(/^\s*one\s+\{\{([\s\S]*?)\}\}\s*$/mu.exec(message)?.[1] ?? '(none)');
  const first = $derived(message.search(/\{\$/));
  const dates = $derived(message.replace(/(?<y>\d{4})-(?<m>\d\d)-(?<d>\d\d)/g, '$<d>.$<m>.$<y>'));
  const marked = $derived(message.match(/\{\$\w+( :\w+)?\}/)?.[1] ?? '-');

  function sample(text: string) {
    message = text;
  }
</script>

<main>
  <div class="row">
    <input id="name" type="text" aria-label="Variable" bind:value={name} />
    <span id="valid" class={valid ? 'valid' : 'invalid'}>{valid ? 'valid' : 'invalid'}</span>
  </div>
  <div class="row"><textarea id="message" aria-label="Message" bind:value={message}></textarea></div>
  <div class="row">
    <button id="plural" onclick={() => sample('.match {$n :number}\none {{One file on 2024-05-17}}\n* {{{$n} files}}')}>Plural</button>
    <button id="plain" onclick={() => sample('Dates: 2001-02-03, 1999-12-31.')}>Plain</button>
  </div>
  <p id="parts">{#each parts as part, i}{#if i % 2 === 1}<span class="ph">{part}</span>{:else}{part}{/if}{/each}</p>
  <p id="names">{names.join(' ')}</p>
  <p id="preview">{preview}</p>
  <p id="stats">{words} words, first at {first}, marked {marked}</p>
  <p id="plural-one">{plural}</p>
  <p id="dates">{dates}</p>
</main>
