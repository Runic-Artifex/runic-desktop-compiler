<script lang="ts">
  // The invoice table's width: wider than its columns (the excess goes to the
  // auto columns, not the fixed one), automatic, and narrower than its columns.
  const widths = ['full', '', 'narrow'];
  let index = $state(0);
  const invoices = [
    ['INV001', 'Paid', 'Credit Card', '$250.00'],
    ['INV002', 'Pending', 'PayPal', '$150.00'],
    ['INV003', 'Unpaid', 'Bank Transfer', '$350.00'],
  ];
</script>

<div class="controls">
  <button id="next" onclick={() => (index = (index + 1) % widths.length)}>next width</button>
</div>
<table id="invoices" class={widths[index]}>
  <thead>
    <tr>
      <th id="invoice" class="fixed">Invoice</th>
      <th id="status">Status</th>
      <th id="method">Method</th>
      <th id="amount" class="right">Amount</th>
    </tr>
  </thead>
  <tbody>
    {#each invoices as row}
      <tr>
        <td>{row[0]}</td>
        <td>{row[1]}</td>
        <td>{row[2]}</td>
        <td class="right">{row[3]}</td>
      </tr>
    {/each}
  </tbody>
</table>
<table id="fixed-only" class="wide">
  <tbody><tr>
    <td id="fixed-a" style="width:60px">Sixty</td>
    <td id="fixed-b" style="width:120px">One hundred twenty</td>
  </tr></tbody>
</table>
<table id="percent" class="wide">
  <tbody><tr>
    <td id="percent-a" class="quarter">Quarter</td>
    <td id="percent-b">Auto column</td>
    <td id="percent-c" style="width:50px">Fifty</td>
  </tr></tbody>
</table>
<table id="cols" class="wide">
  <colgroup><col style="width:90px" /><col /></colgroup>
  <tbody><tr>
    <td id="col-a">Col width</td>
    <td id="col-b">Auto</td>
  </tr></tbody>
</table>
