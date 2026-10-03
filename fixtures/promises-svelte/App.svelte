<script lang="ts">
  let log = $state('');
  let count = $state(0);
  let order: string[] = [];
  function chains() {
    order = [];
    const p = Promise.resolve(1);
    p.then(v => { order.push('a' + v); });
    queueMicrotask(() => order.push('m'));
    const q = new Promise<number>(resolve => resolve(2));
    q.then(v => order.push('b' + v)).then(() => order.push('c'));
    Promise.reject(new Error('x')).catch(e => order.push('e:' + e.message));
    p.then(v => Promise.resolve(v + 10)).then(v => order.push('adopt' + v));
    p.finally(() => order.push('f')).then(v => order.push('fv' + v));
    Promise.all([p, q, Promise.resolve(3)]).then(vs => order.push('all' + vs.join(',')));
    new Promise<number>((_, reject) => reject(new Error('r'))).then(() => order.push('no'), e => order.push('r:' + e.message));
    setTimeout(() => { log = order.join(' '); }, 0);
  }
  function later() {
    new Promise<number>(resolve => setTimeout(() => resolve(count + 1), 50))
      .then(v => { count = v; return v * 2; })
      .then(v => { log = `later ${v}`; });
  }
</script>
<main><h1 id="title">Promises</h1>
<p id="log">{log}</p>
<p id="count">{count}</p>
<div class="controls"><button id="chains" onclick={chains}>Chains</button><button id="later" onclick={later}>Later</button></div>
</main>
