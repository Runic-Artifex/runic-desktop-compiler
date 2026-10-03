<script lang="ts">
let text=$state('');let locked=$state(false);let readonly=$state(false);let show=$state(true);
let length=$derived(text.length);
function clear(){text='';}
function lock(){locked=!locked;}
function readOnly(){readonly=!readonly;}
function toggle(){show=!show;}
</script>
<main><h1 id="heading">Native text editor</h1><input id="editor" aria-label="Text" type="text" maxlength="256" bind:value={text} disabled={locked} {readonly}/><p id="preview">{text}</p><p id="count">{length}</p><button id="clear" disabled={text===''} onclick={clear}>Clear</button><button id="lock" onclick={lock}>Lock</button><button id="readonly" onclick={readOnly}>Read only</button><button id="toggle" onclick={toggle}>Toggle details</button>{#if show}<p id="details">Stable editor identity</p>{/if}</main>
