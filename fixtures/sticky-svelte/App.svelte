<script lang="ts">
  let clicks = $state(0);
  const links = Array.from({ length: 24 }, (_, i) => `Page ${i + 1}`);
  const rows = Array.from({ length: 12 }, (_, i) => i + 1);
  const entries = Array.from({ length: 14 }, (_, i) => `Heading ${i + 1}`);
</script>

<header id="site-header" class="site-header">
  <button id="header-button" onclick={() => clicks++}>Header {clicks}</button>
  <span id="header-title">Sticky site header</span>
</header>
<div id="layout" class="layout">
  <aside id="sidebar" class="sidebar">
    {#each links as link, i}
      <span id={`link-${i + 1}`} class="item">{link}</span>
    {/each}
    <div id="sidebar-fade" class="sidebar-fade"></div>
  </aside>
  <div id="content" class="content">
    <section id="intro" class="section tall">
      <p>Sticky boxes in a page, in panes and in a grid.</p>
    </section>
    <section id="table-section" class="section">
      <div id="table-pane" class="table-pane">
        <table id="table">
          <thead id="thead" class="sticky-head">
            <tr>
              <th id="corner" class="first">Key</th>
              <th>Alpha</th>
              <th>Beta</th>
              <th>Gamma</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row}
              <tr>
                <th id={`row-${row}`} class="first">Row {row}</th>
                <td>{row * 11}</td>
                <td>{row * 23}</td>
                <td>{row * 37}</td>
                <td>{row * 41}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
    <section id="dialog-section" class="section">
      <div id="dialog" class="dialog">
        <div class="body">
          {#each rows as row}
            <p>Dialog line {row}: content that scrolls under a sticky footer.</p>
          {/each}
        </div>
        <footer id="dialog-footer" class="dialog-footer">
          <button id="dialog-cancel" onclick={() => clicks++}>Cancel</button>
          <button id="dialog-save">Save</button>
        </footer>
      </div>
    </section>
    <section id="grid-section" class="section">
      <div id="grid" class="grid">
        <div id="grid-pin" class="pin">Pinned in its area</div>
        <div id="grid-cell" class="cell">A tall cell beside the pin.</div>
      </div>
    </section>
    <section id="nested-section" class="section">
      <div id="outer" class="outer">
        <div id="outer-head" class="outer-head">Outer header</div>
        <p>Outer content before the inner pane.</p>
        <div id="inner" class="inner">
          <div id="inner-head" class="inner-head">Inner header</div>
          {#each rows as row}
            <p>Inner line {row}</p>
          {/each}
        </div>
        {#each rows as row}
          <p>Outer line {row}</p>
        {/each}
      </div>
    </section>
    <section id="strip-section" class="section">
      <div id="strip" class="strip">
        {#each rows as row}
          <span class="chip">Chip {row}</span>
        {/each}
        <span id="strip-end" class="end">End</span>
      </div>
    </section>
    <section id="outro" class="section tall"></section>
  </div>
  <aside id="toc" class="toc">
    <p id="toc-title" class="toc-title">On This Page</p>
    {#each entries as entry, i}
      <span id={`entry-${i + 1}`} class="entry">{entry}</span>
    {/each}
  </aside>
</div>
<div id="footer" class="footer"></div>
