<script>
let n=$state(1);let seen=$state(0);let observed=$state(0);let during=$state(0);let show=$state(true);
// svelte-ignore state_referenced_locally
const initial=n; // Intentional setup capture; conformance checks that it stays 1.
let label=$derived(n);let doubled=$derived.by(()=>n*2);
function sequence(){const captured=n;n=2;const middle=doubled;n=Math.min(n+1,3);seen=captured;observed=doubled;during=middle;}
function increment(){n=Math.min(n+1,3);}
function toggle(){show=!show;}
</script>
<main><h1 id="heading">Counter</h1><p id="value">{label}</p><p id="seen">{seen}</p><p id="observed">{observed}</p><p id="during">{during}</p><p id="initial">{initial}</p><p id="flag">{show}</p><button id="sequence" onclick={sequence}>Sequence</button><button id="increment" disabled={n===3} onclick={increment}>Increment</button><button id="toggle" onclick={toggle}>Toggle</button>{#if show}<p id="details">Visible</p>{/if}</main>
