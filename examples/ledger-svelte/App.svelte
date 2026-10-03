<script lang="ts">
  interface Entry {
    label: string;
    amount: number;
    category: string;
    paid: boolean;
  }

  const presets: Entry[] = [
    { label: 'Coffee', amount: 3.5, category: 'food', paid: false },
    { label: 'Train ticket', amount: 12.4, category: 'travel', paid: false },
    { label: 'Notebook', amount: 7.25, category: 'office', paid: true },
    { label: 'Lunch', amount: 9.9, category: 'food', paid: false },
  ];

  let entries = $state<Entry[]>([]);
  let draft = $state('');
  let added = $state(0);

  const total = $derived(entries.reduce((sum, e) => sum + e.amount, 0));
  const unpaid = $derived(entries.filter((e) => !e.paid));
  const largest = $derived(entries.reduce((max, e) => Math.max(max, e.amount), 0));
  const categories = $derived.by(() => {
    const counts = new Map<string, number>();
    const names: string[] = [];
    for (const e of entries) {
      if (!counts.has(e.category)) names.push(e.category);
      counts.set(e.category, (counts.get(e.category) ?? 0) + e.amount);
    }
    names.sort();
    return names.map((name) => `${name}: ${(counts.get(name) ?? 0).toFixed(2)}`).join(', ');
  });

  function describe(list: Entry[]): string {
    if (list.length === 0) return 'nothing';
    const labels = list.map((e) => e.label);
    if (labels.length > 2) return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
    return labels.join(' and ');
  }

  function addPreset() {
    const preset = presets[added % presets.length];
    entries.push({ ...preset });
    added += 1;
  }

  function addDraft() {
    const label = draft.trim();
    if (label.length === 0) return;
    const name = label.slice(0, 1).toUpperCase() + label.slice(1);
    entries.push({ label: name, amount: label.length * 1.5, category: 'custom', paid: false });
    draft = '';
  }

  function payFirst() {
    const entry = entries.find((e) => !e.paid);
    if (entry) entry.paid = true;
  }

  function removeLast() {
    entries.pop();
  }
</script>

<main>
  <h1>Ledger</h1>
  <p id="count">{entries.length} entries, {unpaid.length} unpaid</p>
  <p id="total">Total: {total.toFixed(2)}, largest: {largest.toFixed(2)}</p>
  <p id="unpaid">Unpaid: {describe(unpaid)}</p>
  <p id="categories">{categories || 'No categories yet'}</p>
  <div class="row">
    <input id="draft" type="text" bind:value={draft} />
    <button id="add-draft" onclick={addDraft} disabled={draft.trim() === ''}>Add</button>
  </div>
  <div class="row">
    <button id="add" onclick={addPreset}>Add preset</button>
    <button id="pay" onclick={payFirst} disabled={unpaid.length === 0}>Pay first unpaid</button>
    <button id="remove" onclick={removeLast} disabled={entries.length === 0}>Remove last</button>
  </div>
</main>
