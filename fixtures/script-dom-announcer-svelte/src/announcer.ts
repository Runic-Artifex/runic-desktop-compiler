// bits-ui 2.19.2's announcer (dist/internal/date-time/announcer.js) with the
// types of its declaration file: a live region created by script, inserted
// at the start of the body, found again by a later call through the
// document. (The optional parameters are typed with `| undefined`, as the
// declaration file's `kind?:` types them for callers.)
const srOnlyStylesString =
  'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; transform: translateX(-100%)';

const isBrowser = typeof document !== 'undefined';

function isHTMLElement(element: unknown): element is HTMLElement {
  return element instanceof HTMLElement;
}

type AnnouncementKind = 'assertive' | 'polite';

function initAnnouncer(doc: Document | null) {
  if (!isBrowser || !doc) return null;
  let el = doc.querySelector('[data-bits-announcer]');
  const createLog = (kind: AnnouncementKind) => {
    const log = doc.createElement('div');
    log.role = 'log';
    log.ariaLive = kind;
    log.setAttribute('aria-relevant', 'additions');
    return log;
  };
  if (!isHTMLElement(el)) {
    const div = doc.createElement('div');
    div.style.cssText = srOnlyStylesString;
    div.setAttribute('data-bits-announcer', '');
    div.appendChild(createLog('assertive'));
    div.appendChild(createLog('polite'));
    el = div;
    doc.body.insertBefore(el, doc.body.firstChild);
  }
  const getLog = (kind: AnnouncementKind) => {
    if (!isHTMLElement(el)) return null;
    const log = el.querySelector(`[aria-live="${kind}"]`);
    if (!isHTMLElement(log)) return null;
    return log;
  };
  return { getLog };
}

export function getAnnouncer(doc: Document | null) {
  const announcer = initAnnouncer(doc);
  function announce(
    value: string | null | number,
    kind: AnnouncementKind | undefined = 'assertive',
    timeout: number | undefined = 7500,
  ): number | undefined {
    if (!announcer || !isBrowser || !doc) return;
    const log = announcer.getLog(kind);
    const content = doc.createElement('div');
    if (typeof value === 'number') {
      value = value.toString();
    } else if (value === null) {
      value = 'Empty';
    } else {
      value = value.trim();
    }
    content.innerText = value;
    if (kind === 'assertive') {
      log?.replaceChildren(content);
    } else {
      log?.appendChild(content);
    }
    return setTimeout(() => {
      content.remove();
    }, timeout);
  }
  return { announce };
}
