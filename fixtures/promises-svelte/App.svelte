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
  const tick = (v: number): Promise<number> => Promise.resolve(v);
  async function add(a: number, b: number): Promise<number> {
    const x = await tick(a);
    order.push('x' + x);
    const y = await b;
    order.push('y' + y);
    return x + y;
  }
  async function chain(): Promise<number> {
    return tick(5);
  }
  async function loop(n: number): Promise<number> {
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += await tick(i);
      if (i === 2) continue;
      order.push('i' + i);
    }
    let k = 0;
    while (k < 2) {
      k = await tick(k + 1);
    }
    for (const v of [10, 20]) {
      total += await v;
    }
    return total + k;
  }
  async function guarded(): Promise<string> {
    try {
      await Promise.reject(new Error('boom'));
      order.push('unreached');
    } catch (e) {
      order.push('caught ' + e.message);
    }
    return 'done';
  }
  async function fails(): Promise<void> {
    await tick(1);
    throw new Error('late');
  }
  function asyncs() {
    order = [];
    add(1, 2).then(v => order.push('add' + v));
    chain().then(v => order.push('chain' + v));
    loop(4).then(v => order.push('loop' + v));
    guarded().then(v => order.push('g ' + v));
    fails().catch(e => order.push('fails ' + e.message));
    order.push('sync');
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
<div class="controls"><button id="chains" onclick={chains}>Chains</button><button id="later" onclick={later}>Later</button><button id="asyncs" onclick={asyncs}>Async</button><button id="slow" onclick={async () => { count += 1; await new Promise<number>(r => setTimeout(() => r(0), 40)); count += 10; log = 'slow ' + count; }}>Slow</button></div>
</main>
