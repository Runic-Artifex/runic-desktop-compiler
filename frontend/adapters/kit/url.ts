// URLs of the SvelteKit router (docs/design/M6-SVELTEKIT.md), without the
// origin: the native app has none, so every URL is a location relative to it
// (`/path?query#fragment`), resolved as `new URL(input, base)` resolves it
// (`__runic.resolve`). `page.url` and the `url` of load functions are
// KitURLs: `pathname`, `search`, `hash` and `searchParams`; members that
// include the origin (`href`, `origin`, `host`, …) are not provided.
//
// This file is compiled into the app with the rest of the router (it is not
// part of the compiler itself).

/** `URLSearchParams` over a query (read-only). */
export class KitSearchParams {
  #pairs: string[][];

  constructor(search: string) {
    this.#pairs = __runic.queryPairs(search);
  }

  get(name: string): string | null {
    for (const pair of this.#pairs) if (pair[0] === name) return pair[1];
    return null;
  }

  getAll(name: string): string[] {
    const out: string[] = [];
    for (const pair of this.#pairs) if (pair[0] === name) out.push(pair[1]);
    return out;
  }

  has(name: string): boolean {
    for (const pair of this.#pairs) if (pair[0] === name) return true;
    return false;
  }

  /** The names in order (`URLSearchParams#keys()`, iterated). */
  keys(): string[] {
    const out: string[] = [];
    for (const pair of this.#pairs) out.push(pair[0]);
    return out;
  }

  get size(): number {
    return this.#pairs.length;
  }
}

/**
 * A URL as `new URL(href)` gives it, for an `href` without the origin.
 * Immutable: a changed URL is a new KitURL.
 */
export class KitURL {
  /** The location without the origin (`url.href` minus `url.origin`). */
  readonly __href: string;
  readonly pathname: string;
  /** `?` and the query, or empty for an empty query. */
  readonly search: string;
  /** `#` and the fragment, or empty for an empty fragment. */
  readonly hash: string;
  readonly searchParams: KitSearchParams;

  constructor(href: string) {
    this.__href = href;
    const at = href.indexOf('#');
    const beforeHash = at < 0 ? href : href.slice(0, at);
    const fragment = at < 0 ? '' : href.slice(at);
    const q = beforeHash.indexOf('?');
    this.pathname = q < 0 ? beforeHash : beforeHash.slice(0, q);
    const query = q < 0 ? '' : beforeHash.slice(q);
    this.search = query === '?' ? '' : query;
    this.hash = fragment === '#' ? '' : fragment;
    this.searchParams = new KitSearchParams(this.search);
  }
}

/** `new URL(input, base)` (without the origin); undefined for other origins. */
export function resolve(input: string, base: string): KitURL | undefined {
  const href = __runic.resolve(input, base);
  return href === undefined ? undefined : new KitURL(href);
}

/** The location (`new URL(location.href)`). */
export function location_url(): KitURL {
  return new KitURL(location.pathname + location.search + location.hash);
}

/** `location.href` without the origin. */
export function location_href(): string {
  return location.pathname + location.search + location.hash;
}

/** `strip_hash(location)`: the location up to its first `#`. */
export function strip_hash_location(): string {
  return location.pathname + location.search;
}

/** `strip_hash(url)`. */
export function strip_hash(url: KitURL): string {
  const at = url.__href.indexOf('#');
  return at < 0 ? url.__href : url.__href.slice(0, at);
}

/** The URL with another pathname (`url.pathname = …` on a copy). */
export function with_pathname(url: KitURL, pathname: string): KitURL {
  const at = url.__href.indexOf('#');
  const fragment = at < 0 ? '' : url.__href.slice(at);
  const beforeHash = at < 0 ? url.__href : url.__href.slice(0, at);
  const q = beforeHash.indexOf('?');
  const query = q < 0 ? '' : beforeHash.slice(q);
  const resolved = __runic.resolve(pathname + query + fragment, url.__href);
  return new KitURL(resolved ?? url.__href);
}

/** `url.search = url.search` (an empty query `?` is removed). */
export function normalize_search(url: KitURL): KitURL {
  const at = url.__href.indexOf('#');
  const beforeHash = at < 0 ? url.__href : url.__href.slice(0, at);
  if (!beforeHash.endsWith('?')) return url;
  const fragment = at < 0 ? '' : url.__href.slice(at);
  return new KitURL(beforeHash.slice(0, beforeHash.length - 1) + fragment);
}

/** Kit's `normalize_path(path, 'never')` (no `trailingSlash` page option). */
export function normalize_path(path: string): string {
  if (path === '/') return path;
  return path.endsWith('/') ? path.slice(0, path.length - 1) : path;
}

/** Kit's `decode_pathname`: decodeURI, keeping `%25`. */
export function decode_pathname(pathname: string): string {
  return pathname
    .split('%25')
    .map(part => decodeURI(part))
    .join('%25');
}
