// The SvelteKit 2.70.1 client router (src/runtime/client/client.js), ported
// to the language the compiler lowers (docs/design/M6-SVELTEKIT.md). It is
// compiled into every SvelteKit app, together with the app module the
// compiler generates from the route manifest (routes, loads, composition),
// which registers itself through `start`.
//
// Ported: starting at the current location (`enter`), link clicks, `goto`,
// back and forward (`popstate`), `beforeNavigate` with cancellation,
// `afterNavigate`, universal loads with Kit's dependency tracking,
// `error`/`redirect`, error pages, the history entries' indices and scroll
// positions, scrolling and focus after a navigation. Not ported (the
// compiler rejects what reaches them, or the runtime reports them):
// server data, preloading, invalidation, shallow routing, snapshots, forms,
// service workers, full-page navigations (to other documents).
//
// Function order and `await`s follow client.js, so that microtasks run in
// the same order as in the browser.
import { settled, tick } from 'svelte';
import { Params } from './params.ts';
import { Uses } from './load.ts';
import { internal as page, type KitError, type KitRoute, type PageValue } from './page.svelte.ts';
import {
  decode_pathname,
  KitURL,
  location_href,
  location_url,
  resolve,
  strip_hash,
  strip_hash_location,
  with_pathname,
} from './url.ts';

/** An identity (`{}` tokens of client.js). */
export class Token {
  readonly __token = true;
}

/** `{ x: pageXOffset, y: pageYOffset }`. */
export type Scroll = { x: number; y: number };

export function scroll_state(): Scroll {
  return { x: window.scrollX, y: window.scrollY };
}

/** A navigation's intent: its route and parameters. */
export class Intent {
  id: string;
  invalidating: boolean;
  route: number;
  route_id: string;
  params: Params;
  /** The URL (normalised when the navigation's result is built, as client.js mutates it). */
  url: KitURL;

  constructor(
    id: string,
    invalidating: boolean,
    route: number,
    route_id: string,
    params: Params,
    url: KitURL,
  ) {
    this.id = id;
    this.invalidating = invalidating;
    this.route = route;
    this.route_id = route_id;
    this.params = params;
    this.url = url;
  }
}

/**
 * The changes a navigation brings, which decide whether a load runs again
 * (client.js `load_route`: url_changed, route_changed, search_params_changed).
 */
export class LoadContext {
  url_changed: boolean;
  route_changed: boolean;
  search_params_changed: string[];
  params: Params;

  constructor(intent: Intent) {
    const current_url = R.current_url;
    this.url_changed = current_url !== undefined ? intent.id !== get_page_key(current_url) : false;
    this.route_changed = R.has_route ? intent.route_id !== R.current_route_id : false;
    this.search_params_changed = diff_search_params(current_url, intent.url);
    this.params = intent.params;
  }

  /** client.js `has_changed` (no invalidation, no server data). */
  has_changed(parent_changed: boolean, uses: Uses | undefined): boolean {
    if (!uses) return false;
    if (uses.parent && parent_changed) return true;
    if (uses.route && this.route_changed) return true;
    if (uses.url && this.url_changed) return true;
    for (const tracked of uses.search_params)
      if (this.search_params_changed.includes(tracked)) return true;
    for (const param of uses.params)
      if (this.params.get(param) !== R.current_params?.get(param)) return true;
    return false;
  }
}

/** A navigation's result: a redirect, or the pages to show. */
export class NavResult {
  /** A redirect's location (`type: 'redirect'`). */
  redirect: string | undefined = undefined;
  url: KitURL;
  params: Params;
  /** The route (null for the root error page after an unknown path). */
  has_route: boolean;
  route_id: string | null;
  error: KitError | null;
  /** `props.page`: the new page, or a copy of the current one. */
  page: PageValue;
  /** `current = { ...state }`: the branch's nodes become the current ones. */
  adopt: () => void;
  /** `root.$set(props)`: the composition and its data. */
  apply: () => void;

  constructor(
    url: KitURL,
    params: Params,
    has_route: boolean,
    route_id: string | null,
    error: KitError | null,
    page_value: PageValue,
    adopt: () => void,
    apply: () => void,
  ) {
    this.url = url;
    this.params = params;
    this.has_route = has_route;
    this.route_id = route_id;
    this.error = error;
    this.page = page_value;
    this.adopt = adopt;
    this.apply = apply;
  }
}

/** A redirect result (`{ type: 'redirect', location }`). */
export function redirect_result(location: string): NavResult {
  const r = new NavResult(
    new KitURL('/'),
    new Params(),
    false,
    null,
    null,
    clone_page(),
    () => {},
    () => {},
  );
  r.redirect = location;
  return r;
}

/** A route of the app (the generated module). */
export type RouteDef = {
  id: string;
  index: number;
  /** The parameters of a path the route matches (decoded), or undefined. */
  exec: (path: string) => Params | undefined;
};

/** The client error hook's input (`HandleClientError`; `error` is not provided). */
export type HandleErrorInput = {
  event: NavigationEvent;
  status: number;
  message: string;
};

/** What the generated app module provides. */
export type AppHooks = {
  hash: boolean;
  routes: RouteDef[];
  load_route: (intent: Intent) => Promise<NavResult>;
  /** `load_root_error_page` (the root layout and the root error page). */
  root_error: (
    url: KitURL,
    status: number,
    error: KitError,
    route_id: string | null,
  ) => Promise<NavResult>;
  /** `src/hooks.client`'s `handleError`, if the app has one. */
  handle_error: ((input: HandleErrorInput) => KitError | undefined) | undefined;
  /** The root layout's and root error page's module loaders (`nodes[0]`, `nodes[1]`). */
  default_loaders: () => void;
  /** The `data-sveltekit-*` attributes of the container and `<body>` (app.html). */
  link_options: (name: string) => string | null;
  /** The responses of prerendered endpoints by URL (build-time data, `runic generate`). */
  fetch_table: (url: string) => KitResponse | undefined;
  /** Marks the app as mounted (Kit creates its root component). */
  mount: () => void;
};

/** `NavigationTarget`. */
export class NavigationTarget {
  params: Params | null | undefined;
  route: KitRoute;
  url: KitURL | null;
  scroll: Scroll | null;

  constructor(
    params: Params | null | undefined,
    route: KitRoute,
    url: KitURL | null,
    scroll: Scroll | null,
  ) {
    this.params = params;
    this.route = route;
    this.url = url;
    this.scroll = scroll;
  }
}

/** `Navigation` (and `AfterNavigate`). */
export class Navigation {
  from: NavigationTarget | null;
  to: NavigationTarget | null;
  type: string;
  willUnload: boolean;
  delta: number | undefined = undefined;
  complete: Promise<void>;

  constructor(
    from: NavigationTarget | null,
    to: NavigationTarget | null,
    type: string,
    willUnload: boolean,
    complete: Promise<void>,
  ) {
    this.from = from;
    this.to = to;
    this.type = type;
    this.willUnload = willUnload;
    this.complete = complete;
  }
}

/** `BeforeNavigate`: the navigation and `cancel()`. */
export class BeforeNavigate {
  from: NavigationTarget | null;
  to: NavigationTarget | null;
  type: string;
  willUnload: boolean;
  delta: number | undefined;
  complete: Promise<void>;
  cancel: () => void;

  constructor(n: Navigation, cancel: () => void) {
    this.from = n.from;
    this.to = n.to;
    this.type = n.type;
    this.willUnload = n.willUnload;
    this.delta = n.delta;
    this.complete = n.complete;
    this.cancel = cancel;
  }
}

/** `NavigationEvent` (the client error hook's `event`). */
export type NavigationEvent = { params: Params; route: KitRoute; url: KitURL };

/** A navigation with its completion (`create_navigation`). */
export class NavHandle {
  navigation: Navigation;
  fulfil: (v: void) => void;
  reject: (e: Error) => void;

  constructor(navigation: Navigation, fulfil: (v: void) => void, reject: (e: Error) => void) {
    this.navigation = navigation;
    this.fulfil = fulfil;
    this.reject = reject;
  }
}

/** The router's state (client.js module variables). */
class RouterState {
  app: AppHooks | undefined = undefined;
  token = new Token();
  started = false;
  autoscroll = true;
  updating = false;
  is_navigating = false;
  hash_navigating = false;
  has_navigated = false;
  resetting_focus = false;
  current_history_index = 0;
  current_navigation_index = 0;
  /** history index → scroll position (client.js `scroll_positions`). */
  scroll_positions = new Map<number, Scroll>();
  reroute_cache = new Map<string, Promise<KitURL | undefined>>();
  before_navigate_callbacks: ((navigation: BeforeNavigate) => void)[] = [];
  after_navigate_callbacks: ((navigation: Navigation) => void)[] = [];
  /** `current`: url, params, route, error (the branch is the app module's). */
  current_url: KitURL | undefined = undefined;
  current_params: Params | undefined = undefined;
  has_route = false;
  current_route_id: string | null = null;
  current_error: KitError | null = null;
}

export const R = new RouterState();

function A(): AppHooks {
  const app = R.app;
  if (!app) throw new Error('The router has not started');
  return app;
}

// --- Errors thrown by `error()` and `redirect()` (frontend/adapters/kit/kit.ts) ---

const HTTP_ERROR = '\u0000HttpError ';
const REDIRECT = '\u0000Redirect ';

/** The status of an `error()` (HttpError), else undefined. */
export function http_status(e: Error): number | undefined {
  if (!e.message.startsWith(HTTP_ERROR)) return undefined;
  const end = e.message.indexOf('\u0000', HTTP_ERROR.length);
  return Number(e.message.slice(HTTP_ERROR.length, end));
}

/** The body of an `error()`: `{ message }`. */
export function http_body(e: Error): KitError {
  const end = e.message.indexOf('\u0000', HTTP_ERROR.length);
  return { message: e.message.slice(end + 1) };
}

/** The location of a `redirect()`, else undefined. */
export function redirect_location(e: Error): string | undefined {
  if (!e.message.startsWith(REDIRECT)) return undefined;
  const end = e.message.indexOf('\u0000', REDIRECT.length);
  return e.message.slice(end + 1);
}

/**
 * `handle_error` for errors thrown by loads (client.js): an HttpError's
 * body; otherwise the client error hook with status 500 and the message
 * `Internal Error`. Without a hook, Kit's default hook logs the error
 * object (`console.error(error)`: its stack trace), which the native
 * runtime cannot reproduce.
 */
export function handle_error(e: Error, event: NavigationEvent): KitError {
  if (http_status(e) !== undefined) return http_body(e);
  return handle_error_with(500, 'Internal Error', event, `the load error "${e.message}"`);
}

/** `handle_error(new SvelteKitError(status, text, message), event)`. */
export function handle_kit_error(
  status: number,
  text: string,
  message: string,
  event: NavigationEvent,
): KitError {
  return handle_error_with(status, text, event, `SvelteKitError: ${message}`);
}

function handle_error_with(
  status: number,
  message: string,
  event: NavigationEvent,
  what: string,
): KitError {
  const hook = A().handle_error;
  if (hook === undefined) {
    __runic.unsupported(
      `SvelteKit's default handleError logs ${what} with its stack trace (console.error); define handleError in src/hooks.client`,
    );
    return { message };
  }
  return hook({ event, status, message }) ?? { message };
}

// --- URLs ---

/** client.js `get_url_path`. */
function get_url_path(url: KitURL): string {
  if (A().hash) {
    const path = decode_pathname(url.hash.replace(/^#/, '').replace(/[?#].+/, ''));
    return path === '' ? '/' : path;
  }
  const path = decode_pathname(url.pathname);
  return path === '' ? '/' : path;
}

/** client.js `get_page_key`. */
export function get_page_key(url: KitURL): string {
  return (A().hash ? url.hash.replace(/^#/, '') : url.pathname) + url.search;
}

/** utils.js `is_external_url` (same origin, no base path). */
function is_external_url(url: KitURL): boolean {
  if (A().hash) return url.pathname !== location.pathname;
  return false;
}

/** client.js `diff_search_params` (the changed names, in order). */
function diff_search_params(old_url: KitURL | undefined, new_url: KitURL): string[] {
  if (!old_url) {
    const keys: string[] = [];
    for (const k of new_url.searchParams.keys()) if (!keys.includes(k)) keys.push(k);
    return keys;
  }
  const changed: string[] = [];
  for (const k of old_url.searchParams.keys()) if (!changed.includes(k)) changed.push(k);
  for (const k of new_url.searchParams.keys()) if (!changed.includes(k)) changed.push(k);
  const out: string[] = [];
  for (const key of changed) {
    const old_values = old_url.searchParams.getAll(key);
    const new_values = new_url.searchParams.getAll(key);
    const same =
      old_values.every(v => new_values.includes(v)) &&
      new_values.every(v => old_values.includes(v));
    if (!same) out.push(key);
  }
  return out;
}

/** The history entry's indices (`history.state[HISTORY_INDEX]`, `[NAVIGATION_INDEX]`). */
function history_indices(): number[] | undefined {
  const state = history.state;
  if (state === null) return undefined;
  const parts = state.split(' ');
  if (parts.length !== 2) return undefined;
  return [Number(parts[0]), Number(parts[1])];
}

/** A number's truthiness (`if (history.state?.[HISTORY_INDEX])`). */
function truthy(n: number): boolean {
  return n !== 0 && !Number.isNaN(n);
}

function history_entry(history_index: number, navigation_index: number): string {
  return `${history_index} ${navigation_index}`;
}

// --- Reroute and intents ---

async function get_rerouted_url(url: KitURL): Promise<KitURL | undefined> {
  const href = url.__href;
  const cached = R.reroute_cache.get(href);
  if (cached !== undefined) return cached;
  // `app.hooks.reroute` is Kit's default (`() => {}`): the URL itself.
  const reroute = async (): Promise<KitURL | undefined> => {
    await Promise.resolve();
    return url;
  };
  const promise = reroute();
  R.reroute_cache.set(href, promise);
  const rerouted = await promise;
  return rerouted;
}

export async function get_navigation_intent(
  url: KitURL | undefined,
  invalidating: boolean,
): Promise<Intent | undefined> {
  if (!url) return undefined;
  if (is_external_url(url)) return undefined;
  const rerouted = await get_rerouted_url(url);
  if (!rerouted) return undefined;
  const path = get_url_path(rerouted);
  for (const route of A().routes) {
    const params = route.exec(path);
    if (params)
      return new Intent(get_page_key(url), invalidating, route.index, route.id, params, url);
  }
  return undefined;
}

// --- Navigation results ---

/** `clone_page(page)`. */
export function clone_page(): PageValue {
  return {
    error: page.error,
    params: page.params,
    route: page.route,
    status: page.status,
    url: page.url,
  };
}

/**
 * The parts of `get_navigation_result_from_branch` that are not about the
 * branch's data: the normalised URL (client.js mutates the intent's URL)
 * and whether the page changed.
 */
export function normalised_url(url: KitURL): KitURL {
  let out = url;
  // trailingSlash 'never' (page options are not supported).
  const pathname = out.pathname === '/' ? '/' : out.pathname.replace(/\/$/, '');
  if (pathname !== out.pathname) out = with_pathname(out, pathname);
  // `url.search = url.search`: `/?` becomes `/`.
  const at = out.__href.indexOf('#');
  const before = at < 0 ? out.__href : out.__href.slice(0, at);
  if (before.endsWith('?'))
    out = new KitURL(before.slice(0, before.length - 1) + (at < 0 ? '' : out.__href.slice(at)));
  return out;
}

/** `page_changed` of `get_navigation_result_from_branch`. */
export function page_changed(url: KitURL, error: KitError | null, data_changed: boolean): boolean {
  const current = R.current_url;
  return !current || url.__href !== current.__href || R.current_error !== error || data_changed;
}

/** `result.props.page`: a new page when it changed, else `clone_page(page)`. */
export function result_page(
  changed: boolean,
  url: KitURL,
  params: Params,
  route_id: string | null,
  status: number,
  error: KitError | null,
): PageValue {
  if (!changed) return clone_page();
  return { error, params, route: { id: route_id }, status, url: new KitURL(url.__href) };
}

/** `current = { ...navigation_result.state }`. */
function adopt_state(result: NavResult) {
  R.current_url = result.url;
  R.current_params = result.params;
  R.has_route = result.has_route;
  R.current_route_id = result.route_id;
  R.current_error = result.error;
  result.adopt();
}

// --- Navigations ---

/** `create_navigation`. */
function create_navigation(
  intent: Intent | undefined,
  url: KitURL | null,
  type: string,
  target_scroll: Scroll | null,
): NavHandle {
  let fulfil: (v: void) => void = (v: void) => {};
  let reject: (e: Error) => void = (e: Error) => {};
  const complete = new Promise<void>((f, r) => {
    fulfil = f;
    reject = r;
  });
  complete.catch(() => {});
  const from = new NavigationTarget(
    R.current_params,
    { id: R.has_route ? R.current_route_id : null },
    R.current_url ?? null,
    scroll_state(),
  );
  const to =
    url === null
      ? null
      : new NavigationTarget(
          intent !== undefined ? intent.params : null,
          { id: intent !== undefined ? intent.route_id : null },
          url,
          target_scroll,
        );
  return new NavHandle(
    new Navigation(from, to, type, intent === undefined, complete),
    fulfil,
    reject,
  );
}

/** `_before_navigate`: the callbacks may cancel (null). */
function before_navigate(
  url: KitURL,
  type: string,
  intent: Intent | undefined,
  delta: number | undefined,
  scroll: Scroll | null,
): NavHandle | null {
  let should_block = false;
  const nav = create_navigation(intent, url, type, scroll);
  if (delta !== undefined) nav.navigation.delta = delta;
  const cancellable = new BeforeNavigate(nav.navigation, () => {
    should_block = true;
    nav.reject(new Error('navigation cancelled'));
  });
  if (!R.is_navigating) {
    // Set#forEach: callbacks added meanwhile run too.
    const list = R.before_navigate_callbacks;
    for (let i = 0; i < list.length; i++) {
      const fn = list[i];
      fn(cancellable);
    }
  }
  return should_block ? null : nav;
}

/** Options of `navigate`. */
export class NavigateOptions {
  type: string;
  url: KitURL;
  /** A traversal (`popped`): its scroll position and delta. */
  popped = false;
  popped_scroll: Scroll | undefined = undefined;
  popped_delta = 0;
  keepfocus = false;
  noscroll = false;
  replace_state = false;
  redirect_count = 0;
  nav_token: Token = new Token();
  accept: () => void = () => {};
  block: () => void = () => {};

  constructor(type: string, url: KitURL) {
    this.type = type;
    this.url = url;
  }
}

/**
 * A response of a load's `fetch`: a prerendered endpoint's recorded
 * response (build-time data). `res.json()` parses the body into the type
 * the program declares for it (the Svelte adapter lowers the call).
 */
export class KitResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly type: string;
  readonly body: string;

  constructor(status: number, type: string, body: string) {
    this.status = status;
    this.ok = status >= 200 && status <= 299;
    this.type = type;
    this.body = body;
  }

  text(): Promise<string> {
    return Promise.resolve(this.body);
  }
}

/**
 * A load's `fetch` (client.js `resolve_fetch_url`): same-origin URLs of
 * prerendered endpoints, from the build-time table. During the first
 * navigation Kit reads the responses the server rendering inlined; later a
 * fetch is a network round trip (a host task).
 */
export async function kit_fetch(input: string, url: KitURL): Promise<KitResponse> {
  const resolved = __runic.resolve(input, url.__href);
  if (resolved === undefined) {
    __runic.unsupported(
      `a fetch of ${input}, at another origin (the native app makes no network requests)`,
    );
    throw new Error('Unsupported fetch');
  }
  const at = resolved.indexOf('#');
  const key = at < 0 ? resolved : resolved.slice(0, at);
  const response = A().fetch_table(key);
  if (response === undefined) {
    __runic.unsupported(
      `a fetch of ${key}, which is not a prerendered endpoint's response (runic generate records them)`,
    );
    throw new Error('Unsupported fetch');
  }
  if (R.started) await __runic.hostReply();
  return response;
}

/**
 * client.js `load_data`: the server data of a navigation, a network round
 * trip (`__data.json`) once the app has started; the first navigation's
 * data comes with the page, as server rendering inlines it.
 */
export async function load_data(): Promise<void> {
  if (R.started) await __runic.hostReply();
}

/** `native_navigation`: a full-page navigation (another document), not modelled natively. */
async function native_navigation(url: KitURL): Promise<NavResult | undefined> {
  __runic.unsupported(`a full-page navigation to ${url.__href} (SvelteKit loads another document)`);
  return undefined;
}

/** `server_fallback` (an SPA: the root error page in place, or a full-page navigation). */
async function server_fallback(
  url: KitURL,
  route_id: string | null,
  error: KitError,
  status: number,
): Promise<NavResult | undefined> {
  if (url.pathname === location.pathname) {
    const r = await A().root_error(url, status, error, route_id);
    return r;
  }
  const r = await native_navigation(url);
  return r;
}

/**
 * `stores.updated.check()` after a navigation to an error page: Kit fetches
 * `version.json` (two network round trips); a native app is never updated.
 */
export async function updated_check(): Promise<boolean> {
  await __runic.hostReply();
  await __runic.hostReply();
  return false;
}

async function navigate(o: NavigateOptions): Promise<void> {
  const prev_token = R.token;
  const nav_token = o.nav_token;
  R.token = nav_token;
  let url = o.url;
  const intent = await get_navigation_intent(url, false);
  const nav =
    o.type === 'enter'
      ? create_navigation(intent, url, o.type, null)
      : before_navigate(
          url,
          o.type,
          intent,
          o.popped ? o.popped_delta : undefined,
          o.popped ? (o.popped_scroll ?? null) : null,
        );
  if (!nav) {
    o.block();
    if (R.token === nav_token) R.token = prev_token;
    return;
  }
  const previous_history_index = R.current_history_index;
  o.accept();
  R.is_navigating = true;

  let navigation_result: NavResult | undefined = undefined;
  if (intent !== undefined) navigation_result = await A().load_route(intent);

  if (!navigation_result) {
    if (is_external_url(url)) {
      await native_navigation(url);
      return;
    }
    const error = handle_kit_error(404, 'Not Found', `Not found: ${url.pathname}`, {
      params: new Params(),
      route: { id: null },
      url,
    });
    const handled = await Promise.resolve(error);
    navigation_result = await server_fallback(url, null, handled, 404);
  }

  // An internal navigation continues with the normalised URL.
  if (intent !== undefined) url = intent.url;

  if (R.token !== nav_token) {
    nav.reject(new Error('navigation aborted'));
    return;
  }

  if (!navigation_result) return;

  const redirect = navigation_result.redirect;
  if (redirect !== undefined) {
    if (o.redirect_count < 20) {
      const next = new NavigateOptions(o.type, resolve(redirect, url.__href) ?? url);
      next.popped = o.popped;
      next.popped_scroll = o.popped_scroll;
      next.popped_delta = o.popped_delta;
      next.keepfocus = o.keepfocus;
      next.noscroll = o.noscroll;
      next.replace_state = o.replace_state;
      next.redirect_count = o.redirect_count + 1;
      next.nav_token = nav_token;
      if (resolve(redirect, url.__href) === undefined)
        __runic.unsupported(`a redirect to another origin (${redirect})`);
      await navigate(next);
      nav.fulfil();
      return;
    }
    __runic.unsupported(
      'a redirect loop (SvelteKit renders the root error page with a logged error)',
    );
    return;
  } else if (navigation_result.page.status >= 400) {
    const updated = await updated_check();
    if (updated) return;
  }

  R.updating = true;
  R.scroll_positions.set(previous_history_index, scroll_state());

  // The URL's pathname follows the page's trailing slash option.
  if (navigation_result.page.url.pathname !== url.pathname)
    url = with_pathname(url, navigation_result.page.url.pathname);

  if (!o.popped) {
    const change = o.replace_state ? 0 : 1;
    R.current_history_index += change;
    R.current_navigation_index += change;
    const entry = history_entry(R.current_history_index, R.current_navigation_index);
    if (o.replace_state) history.replaceState(entry, '', url.__href);
    else history.pushState(entry, '', url.__href);
    if (!o.replace_state) clear_onward_history(R.current_history_index);
  }

  if (R.started) {
    // onNavigate callbacks (none: onNavigate is not supported).
    const on_navigate: Promise<void>[] = [];
    await Promise.all(on_navigate);
    adopt_state(navigation_result);
    navigation_result.page.url = url;
    // Focus leaves the element before the component tree updates (#14575).
    const focused = __runic.focused();
    if (!o.keepfocus && focused !== null) focused.blur();
    navigation_result.apply();
    page.update(navigation_result.page);
    R.has_navigated = true;
    const before = __runic.focused();
    await settled();
    await tick();
    await tick();
    await finish(o, nav, nav_token, url, before);
  } else {
    await initialize(navigation_result);
    const before = __runic.focused();
    await Promise.resolve();
    await tick();
    await tick();
    await finish(o, nav, nav_token, url, before);
  }
}

/** The end of `navigate`: scrolling, focus, `afterNavigate`. */
async function finish(
  o: NavigateOptions,
  nav: NavHandle,
  nav_token: Token,
  url: KitURL,
  active_before: HTMLElement | null,
): Promise<void> {
  if (R.token !== nav_token) {
    nav.reject(new Error('navigation aborted'));
    return;
  }
  let deep_linked = false;
  if (R.autoscroll) {
    const scroll: Scroll | undefined = o.popped
      ? o.popped_scroll
      : o.noscroll
        ? scroll_state()
        : undefined;
    if (scroll) window.scrollTo(scroll.x, scroll.y);
    else {
      const target = url.hash === '' ? null : document.getElementById(get_id(url));
      if (target) {
        deep_linked = true;
        target.scrollIntoView();
      } else window.scrollTo(0, 0);
    }
  }
  const now = __runic.focused();
  const changed_focus = now !== active_before && now !== null;
  if (!o.keepfocus && !changed_focus) reset_focus(url, !deep_linked);
  R.autoscroll = true;
  R.is_navigating = false;
  nav.fulfil();
  const to = nav.navigation.to;
  if (to) to.scroll = scroll_state();
  const after = R.after_navigate_callbacks;
  for (let i = 0; i < after.length; i++) {
    const fn = after[i];
    fn(nav.navigation);
  }
  R.updating = false;
}

/** `initialize`: the first navigation's result; Kit creates its root component. */
async function initialize(result: NavResult): Promise<void> {
  adopt_state(result);
  page.update(result.page);
  result.apply();
  A().mount();
  await Promise.resolve();
  R.started = true;
}

/** `clear_onward_history`: scroll positions of entries after the current one. */
function clear_onward_history(history_index: number) {
  let i = history_index + 1;
  while (R.scroll_positions.has(i)) {
    R.scroll_positions.delete(i);
    i += 1;
  }
}

/** client.js `get_id`. */
function get_id(url: KitURL): string {
  let id = '';
  if (A().hash) {
    const parts = url.hash.split('#');
    id = parts.length > 2 ? parts[2] : '';
  } else id = url.hash.slice(1);
  return decodeURIComponent(id);
}

/**
 * client.js `reset_focus`: the sequential focus navigation starting point
 * moves to the fragment's element, or to the start of the document (the
 * body is focused and loses focus again). `[autofocus]` elements are
 * rejected by the compiler.
 *
 * For a fragment, Kit navigates to it with `location.replace('#id')` in a
 * timer (scrolling to the element and making it the starting point), then
 * restores the entry's URL and state with `history.replaceState` and, unless
 * it scrolled to the element already, the scroll position. The `popstate`
 * and `hashchange` events of that fragment navigation reach only the
 * router's listeners (the compiler rejects others in SvelteKit apps), which
 * ignore them; so the navigation is its scrolling and starting point.
 */
function reset_focus(url: KitURL, scroll: boolean) {
  const id = get_id(url);
  if (id !== '' && document.getElementById(id) !== null) {
    const saved = scroll_state();
    setTimeout(() => {
      R.resetting_focus = true;
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView();
        __runic.focusStart(element);
      }
      if (scroll) window.scrollTo(saved.x, saved.y);
      R.resetting_focus = false;
    });
    return;
  }
  __runic.resetFocus();
}

// --- The router ---

/** client.js `start` (no server rendering: the `enter` navigation). */
export async function start(app: AppHooks): Promise<void> {
  R.app = app;
  // `await app.hooks.init?.()`.
  await Promise.resolve();
  app.default_loaders();
  const indices = history_indices();
  if (indices !== undefined && truthy(indices[0])) {
    R.current_history_index = indices[0];
    R.current_navigation_index = indices[1];
  } else {
    // Date.now() as an offset so that cross-document navigations keep their data.
    const now = Date.now();
    R.current_history_index = now;
    R.current_navigation_index = now;
    history.replaceState(history_entry(now, now), '');
  }
  const start_url = app.hash ? decode_hash(location_url()) : location_url();
  const o = new NavigateOptions('enter', start_url);
  o.replace_state = true;
  await navigate(o);
  start_router();
}

/** `decode_hash`: the fragment decoded (`url.hash = decodeURIComponent(url.hash)`). */
function decode_hash(url: KitURL): KitURL {
  const decoded = decodeURIComponent(url.hash);
  return resolve(decoded === '' ? strip_hash(url) : decoded, url.__href) ?? url;
}

/** The value of `data-sveltekit-<name>` for `element` and its ancestors (`link_option`). */
function link_option(element: HTMLElement, name: string): string | null {
  let el: HTMLElement | null = element;
  while (el) {
    const value = el.getAttribute(`data-sveltekit-${name}`);
    if (value !== null) return value;
    el = __runic.parent(el);
  }
  // The container and <body> of app.html.
  return A().link_options(name);
}

function option_state(value: string | null): boolean | undefined {
  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** utils.js `find_anchor`: the link the event target is in. */
function find_anchor(element: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = element;
  while (el) {
    if (el.localName === 'a' && el.hasAttribute('href')) return el;
    el = __runic.parent(el);
  }
  return null;
}

/** The click handler of `_start_router` (on `document.documentElement` in Kit). */
async function on_click(event: MouseEvent): Promise<void> {
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.defaultPrevented) return;
  const a = find_anchor(event.target);
  if (!a) return;
  // get_link_info
  const href = a.getAttribute('href') ?? '';
  let url = resolve(href, location_href());
  if (url !== undefined && A().hash && /^#[^/]/.test(url.hash)) {
    const parts = location.hash.split('#');
    const route = parts.length > 1 && parts[1] !== '' ? parts[1] : '/';
    url = resolve(`#${route}${url.hash}`, url.__href) ?? url;
  }
  const target = a.getAttribute('target') ?? '';
  const rel = a.getAttribute('rel') ?? '';
  const external =
    url === undefined ||
    target !== '' ||
    (url !== undefined ? is_external_url(url) : false) ||
    rel.split(/\s+/).includes('external');
  const download = url !== undefined && a.hasAttribute('download');
  if (!url) return;
  // A link opening in another browsing context.
  if (target === '_parent' || target === '_top') {
    // window.parent === window
  } else if (target !== '' && target !== '_self') return;
  const reload = option_state(link_option(a, 'reload'));
  const replace_state = option_state(link_option(a, 'replacestate'));
  const keepfocus = option_state(link_option(a, 'keepfocus'));
  const noscroll = option_state(link_option(a, 'noscroll'));
  if (download) return;
  const parts = (A().hash ? url.hash.replace(/^#/, '') : url.__href).split('#');
  const nonhash = parts[0];
  const hash: string | undefined = parts.length > 1 ? parts[1] : undefined;
  // In Kit the hash router compares a route path with `location.href` (never equal).
  const same_pathname = A().hash ? false : nonhash === strip_hash_location();
  if (external || (reload === true && (!same_pathname || !hash))) {
    if (before_navigate(url, 'link', undefined, undefined, null)) R.is_navigating = true;
    else event.preventDefault();
    return;
  }
  if (hash !== undefined && same_pathname) {
    const current = R.current_url;
    const current_parts = current !== undefined ? current.__href.split('#') : [''];
    const current_hash: string | undefined =
      current_parts.length > 1 ? current_parts[1] : undefined;
    if (current_hash === hash) {
      event.preventDefault();
      if (hash === '' || (hash === 'top' && document.getElementById('top') === null))
        window.scrollTo({ top: 0 });
      else {
        const element = document.getElementById(decodeURIComponent(hash));
        if (element) {
          element.scrollIntoView();
          element.focus();
        }
      }
      return;
    }
    R.hash_navigating = true;
    R.scroll_positions.set(R.current_history_index, scroll_state());
    update_url(url);
    if (!replace_state) return;
    R.hash_navigating = false;
  }
  event.preventDefault();
  // Allow the browser to repaint before navigating.
  await new Promise<void>(fulfil => {
    requestAnimationFrame(() => {
      setTimeout(() => fulfil(), 0);
    });
    setTimeout(() => fulfil(), 100);
  });
  const o = new NavigateOptions('link', url);
  o.keepfocus = keepfocus ?? false;
  o.noscroll = noscroll ?? false;
  o.replace_state = replace_state ?? url.__href === location_href();
  await navigate(o);
}

/** The popstate listener of `_start_router`. */
async function on_popstate(): Promise<void> {
  if (R.resetting_focus) return;
  const indices = history_indices();
  if (indices !== undefined && truthy(indices[0])) {
    const history_index = indices[0];
    R.token = new Token();
    // A cancelled traversal is undone with history.go, which comes back here.
    if (history_index === R.current_history_index) return;
    const scroll = R.scroll_positions.get(history_index);
    const url = location_url();
    const navigation_index = indices[1];
    const current = R.current_url;
    const is_hash_change =
      current !== undefined ? strip_hash_location() === strip_hash(current) : false;
    const shallow =
      navigation_index === R.current_navigation_index && (R.has_navigated || is_hash_change);
    if (shallow) {
      update_url(url);
      R.scroll_positions.set(R.current_history_index, scroll_state());
      if (scroll) window.scrollTo(scroll.x, scroll.y);
      R.current_history_index = history_index;
      return;
    }
    const delta = history_index - R.current_history_index;
    const o = new NavigateOptions('popstate', url);
    o.popped = true;
    o.popped_scroll = scroll;
    o.popped_delta = delta;
    o.accept = () => {
      R.current_history_index = history_index;
      R.current_navigation_index = navigation_index;
    };
    o.block = () => {
      history.go(-delta);
    };
    o.nav_token = R.token;
    await navigate(o);
  } else if (!R.hash_navigating) {
    update_url(location_url());
    // The user edited the hash in the address bar: Kit reloads the page.
    if (A().hash) __runic.unsupported('a reload after a hash change without router state');
  }
}

/** The hashchange listener of `_start_router`. */
function on_hashchange() {
  if (R.hash_navigating) {
    R.hash_navigating = false;
    R.current_history_index += 1;
    history.replaceState(
      history_entry(R.current_history_index, R.current_navigation_index),
      '',
      location_href(),
    );
  }
}

/** `update_url`: the page's URL changes in place. */
function update_url(url: KitURL) {
  R.current_url = url;
  page.url = url;
  notify_page();
}

/** The page store's subscriber (Kit's root component, once mounted). */
class PageStore {
  subscribed = false;
  subscriber: () => void = () => {};
}
export const page_store = new PageStore();

function notify_page() {
  page_store.subscriber();
}

function start_router() {
  document.addEventListener('click', on_click);
  window.addEventListener('popstate', on_popstate);
  window.addEventListener('hashchange', on_hashchange);
}

// --- $app/navigation ---

/** `goto(url, opts)`. */
export async function goto(url: string, opts?: GotoOptions): Promise<void> {
  const resolved = resolve(url, location_href());
  if (!resolved) throw new Error('goto: invalid URL');
  const o = new NavigateOptions('goto', resolved);
  o.keepfocus = opts?.keepFocus ?? false;
  o.noscroll = opts?.noScroll ?? false;
  o.replace_state = opts?.replaceState ?? false;
  await navigate(o);
}

/** `goto`'s options (`invalidateAll`, `invalidate` and `state` are not supported). */
export type GotoOptions = { replaceState?: boolean; noScroll?: boolean; keepFocus?: boolean };

/** `beforeNavigate` registers in `onMount` (the compiler lowers the call so). */
export function before_navigate_register(
  callback: (navigation: BeforeNavigate) => void,
): () => void {
  // A Set in Kit: a callback is held once.
  const list = R.before_navigate_callbacks;
  let present = false;
  for (const f of list) if (f === callback) present = true;
  if (!present) list.push(callback);
  return () => {
    for (let i = 0; i < list.length; i++)
      if (list[i] === callback) {
        list.splice(i, 1);
        return;
      }
  };
}

/** `afterNavigate` registers in `onMount` (the compiler lowers the call so). */
export function after_navigate_register(callback: (navigation: Navigation) => void): () => void {
  const list = R.after_navigate_callbacks;
  let present = false;
  for (const f of list) if (f === callback) present = true;
  if (!present) list.push(callback);
  return () => {
    for (let i = 0; i < list.length; i++)
      if (list[i] === callback) {
        list.splice(i, 1);
        return;
      }
  };
}
