<script lang="ts">
  let log = $state<string[]>([]);
  let overs = $state(0);
  let targets = $state<string[]>([]);
  function record(event: MouseEvent) {
    targets.push(
      `${event.type}:${event.target.id}:${event.currentTarget!.id}:${event.relatedTarget === null ? '-' : event.relatedTarget.id}:${event.button}:${event.buttons}`,
    );
    if (targets.length > 14) targets.shift();
  }
  function add(entry: string) {
    log.push(entry);
    if (log.length > 14) log.shift();
  }
  const names = ['a', 'b', 'c'];
</script>

<!-- The mouse-only listeners below exercise boundary events for conformance. -->
<main>
  <h1>Hover events</h1>
  <!-- svelte-ignore a11y_mouse_events_have_key_events -->
  <ul
    id="list"
    onpointerover={record}
    onpointerout={record}
    onmouseover={event => {
      overs++;
      record(event);
    }}
    onmouseout={event => {
      add('list:out');
      record(event);
    }}
  >
    {#each names as name (name)}
      <!-- svelte-ignore a11y_mouse_events_have_key_events -->
      <li
        id="item-{name}"
        onpointerover={event => {
          add(`${name}:pover`);
          record(event);
        }}
        onpointerout={event => {
          add(`${name}:pout`);
          record(event);
        }}
        onmouseover={event => {
          add(`${name}:over`);
          record(event);
        }}
        onmouseout={event => {
          add(`${name}:out`);
          record(event);
        }}
        onmouseenter={() => add(`${name}:enter`)}
      >
        <span id="label-{name}">{name}</span>
      </li>
    {/each}
  </ul>
  <!-- svelte-ignore a11y_mouse_events_have_key_events -->
  <p
    id="title"
    onpointerover={record}
    onpointerout={record}
    onmouseover={record}
    onmouseout={record}
  >
    Outside the list
  </p>
  <!-- svelte-ignore a11y_mouse_events_have_key_events -->
  <p
    id="direct"
    onpointerover={record}
    onpointerout={record}
    onmouseover={record}
    onmouseout={record}
  >
    Direct {names[0]} target text
  </p>
  <p id="overs">{overs}</p>
  <p id="log">{log.join(' ')}</p>
  <p id="boundary-log">{targets.join(' ')}</p>
</main>
