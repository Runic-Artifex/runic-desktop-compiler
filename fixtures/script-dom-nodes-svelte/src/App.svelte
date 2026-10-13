<script lang="ts">
  // Script DOM, slice 2 (docs/design/M6-SCRIPT-DOM.md): text, comment and
  // fragment nodes, node kinds and data, traversal inside a child list script
  // owns, the ChildNode/ParentNode insertions, removeChild/replaceChild,
  // cloneNode of a rendered element, classList and dataset.
  let host = $state<HTMLElement | null>(null);
  let template = $state<HTMLElement | null>(null);
  let box = $state<HTMLElement | null>(null);
  let report = $state('');
  let n = 0;

  function describe(node: Node | null): string {
    if (!node) return 'null';
    const kind = node.nodeType;
    const value = node.nodeValue;
    return `${node.nodeName}/${kind}/${value === null ? '-' : value}`;
  }

  function build(): void {
    if (!host) return;
    const fragment = document.createDocumentFragment();
    const note = document.createComment('note');
    const em = document.createElement('em');
    em.textContent = 'middle';
    fragment.append('first ', note, em, document.createTextNode(' last'));
    const count = fragment.childNodes.length;
    host.append(fragment);
    report = [
      String(count),
      String(fragment.childNodes.length),
      String(host.childNodes.length),
      String(describe(host.firstChild)),
      String(describe(host.lastChild)),
      String(describe(note.nextSibling)),
      String(describe(em.previousSibling)),
      String(em.parentNode === host),
      String(host.children.length),
      String(describe(host.firstElementChild)),
      String(host.textContent),
      String(note instanceof Comment),
      String(host.firstChild instanceof Text),
      String(em instanceof Element),
      String(note instanceof Element),
      String(fragment instanceof DocumentFragment),
      String(note instanceof Node),
    ].join(' | ');
  }

  function edit(): void {
    if (!host) return;
    const first = host.firstChild;
    const second = host.childNodes[1];
    if (first) first.nodeValue = 'changed ';
    const tag = document.createElement('b');
    tag.textContent = 'B';
    second?.before(tag, '<');
    second?.after('>');
    host.prepend('start ');
    const last = host.lastChild;
    last?.replaceWith('end');
    report = `${host.childNodes.length} | ${host.textContent} | ${describe(host.childNodes[2])}`;
  }

  function swap(): void {
    if (!host) return;
    const em = host.querySelector('em');
    const strong = document.createElement('strong');
    n += 1;
    strong.textContent = `swap ${n}`;
    if (em) host.replaceChild(strong, em);
    const removed = host.removeChild(host.childNodes[0]);
    report = `${describe(removed)} | ${host.textContent}`;
  }

  function copy(): void {
    if (!host || !template) return;
    const deep = template.cloneNode(true);
    const shallow = template.cloneNode();
    host.append(deep, shallow);
    report = `${deep.childNodes.length} | ${shallow.childNodes.length} | ${deep !== template} | ${host.children.length}`;
  }

  function classes(): void {
    if (!host || !box) return;
    const item = document.createElement('span');
    item.className = '  a  b a ';
    item.classList.add('c');
    const toggled = item.classList.toggle('a');
    const forced = item.classList.toggle('b', true);
    const replaced = item.classList.replace('c', 'd');
    item.dataset.itemKey = 'k1';
    item.textContent = 'classed';
    host.append(item);
    box.classList.add('lit');
    box.dataset.state = box.classList.contains('lit') ? 'on' : 'off';
    report = `${item.className} | ${toggled} ${forced} ${replaced} | ${item.dataset.itemKey} | ${item.getAttribute('data-item-key')} | ${box.dataset.state}`;
  }

  function clear(): void {
    host?.replaceChildren();
    box?.classList.remove('lit');
    report = `${host?.childNodes.length}`;
  }
</script>

<div id="app">
  <button id="build" onclick={build}>build</button>
  <button id="edit" onclick={edit}>edit</button>
  <button id="swap" onclick={swap}>swap</button>
  <button id="copy" onclick={copy}>copy</button>
  <button id="classes" onclick={classes}>classes</button>
  <button id="clear" onclick={clear}>clear</button>
  <p id="report">{report}</p>
  <p id="template" class="tpl" data-k="v" bind:this={template}>template <b>bold</b> text</p>
  <div id="box" bind:this={box}>box</div>
  <div id="host" class="host" bind:this={host}></div>
</div>
