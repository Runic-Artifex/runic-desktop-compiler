<script lang="ts">
import {advance as next, amount, ceiling, starting, heading} from './logic.ts';
let n=$state(starting);
let seen=$state(0);
let show=$state(true);
// svelte-ignore state_referenced_locally
const initial=n; // Setup capture deliberately remains zero.
let label=$derived(n);
function increment(){n=next(n,amount,ceiling);}
function sequence(){const before=n;n=next(n,amount,ceiling);seen=before;}
function reset(){n=starting;seen=starting;}
function toggle(){show=!show;}
</script>
<main><h1 id="heading">{heading}</h1><p id="value">{label}</p><p id="seen">{seen}</p><p id="initial">{initial}</p><p id="flag">{show}</p><div class="controls"><button id="increment" disabled={n===ceiling} onclick={increment}>Increment</button><button id="sequence" onclick={sequence}>Sequence</button><button id="reset" onclick={reset}>Reset</button><button id="toggle" onclick={toggle}>Toggle</button></div>{#if show}<p id="details">Visible</p>{/if}</main>
