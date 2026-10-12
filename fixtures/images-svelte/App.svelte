<script lang="ts">
  // Images as pinned assets (M6, docs/design/M6-IMAGES.md): local files of
  // public/ and remote URLs pinned by `runic images` (runic.images.json).
  const AVATAR = 'https://avatars.githubusercontent.com/u/1?s=40';
  const MISSING = 'https://raw.githubusercontent.com/Runic-Artifex/blitz/main/runic-missing-image.png';
  type Source = '/alt.png' | typeof AVATAR | typeof MISSING;

  let avatar = $state('loading');
  let missing = $state('loading');
  let src: Source = $state('/alt.png');
  let switchFailed = $state(false);
  let log = $state<string[]>([]);

  const label = () => (src === '/alt.png' ? 'local' : src === AVATAR ? 'avatar' : 'missing');
  const next = () => {
    log = [...log, 'click'];
    src = src === '/alt.png' ? AVATAR : src === AVATAR ? MISSING : '/alt.png';
  };
</script>

<main>
  <h1>Images</h1>
  <div class="row">
    <img id="sized" src="/tiles.png" width="96" height="72" alt="Tiles at 96 by 72" />
    <img id="intrinsic" src="/tiles.png" alt="Tiles at their own size" decoding="async" />
    <img
      id="avatar"
      src={AVATAR}
      width="40"
      height="40"
      alt="Avatar"
      onload={() => (avatar = 'loaded')}
      onerror={() => (avatar = 'failed')}
    />
    <img
      id="missing"
      class:hidden={missing === 'failed'}
      src={MISSING}
      width="40"
      height="40"
      alt=""
      onload={() => (missing = 'loaded')}
      onerror={() => (missing = 'failed')}
    />
  </div>
  <p id="status">avatar {avatar}, missing {missing}</p>
  <div class="frame">
    <img id="cover" class="cover" src="/wide.png" alt="A wide image covering its box" />
  </div>
  <div class="row">
    <button id="next" onclick={next}>Next image</button>
    <img
      id="switch"
      class:hidden={switchFailed}
      {src}
      alt=""
      onload={() => {
        switchFailed = false;
        log = [...log, 'load ' + label()];
      }}
      onerror={() => {
        switchFailed = true;
        log = [...log, 'error ' + label()];
      }}
    />
  </div>
  <p id="log">{log.join(', ')}</p>
</main>
