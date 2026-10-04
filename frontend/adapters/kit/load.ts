// Load functions in a compiled SvelteKit app (Kit 2.70.1, client.js
// `load_node` and utils/url.js `make_trackable`): what a load reads of its
// event is recorded, so that it runs again only when that changed; and the
// matching of a route's parameters (utils/routing.js `exec`).
import { KitSearchParams, KitURL } from './url.ts';

/** What a load function read (`import('types').Uses`, no `depends`). */
export class Uses {
  params = new Set<string>();
  parent = false;
  route = false;
  url = false;
  search_params = new Set<string>();
}

/** `url.searchParams` of a load: `get`, `getAll` and `has` record the name, other reads the URL. */
export class LoadSearchParams {
  #params: KitSearchParams;
  #uses: Uses;

  constructor(params: KitSearchParams, uses: Uses) {
    this.#params = params;
    this.#uses = uses;
  }

  #track(name: string) {
    this.#uses.search_params.add(name);
  }

  get(name: string): string | null {
    this.#track(name);
    return this.#params.get(name);
  }

  getAll(name: string): string[] {
    this.#track(name);
    return this.#params.getAll(name);
  }

  has(name: string): boolean {
    this.#track(name);
    return this.#params.has(name);
  }

  keys(): string[] {
    this.#uses.url = true;
    return this.#params.keys();
  }

  get size(): number {
    this.#uses.url = true;
    return this.#params.size;
  }
}

/**
 * The `url` of a load: `pathname` and `search` (and `hash` under the hash
 * router) are dependencies; `searchParams` records its names.
 */
export class LoadURL {
  #url: KitURL;
  #uses: Uses;
  #hash: boolean;
  #searchParams: LoadSearchParams;

  constructor(url: KitURL, uses: Uses, hash: boolean) {
    this.#url = url;
    this.#uses = uses;
    this.#hash = hash;
    this.#searchParams = new LoadSearchParams(url.searchParams, uses);
  }

  get pathname(): string {
    this.#uses.url = true;
    return this.#url.pathname;
  }

  get search(): string {
    this.#uses.url = true;
    return this.#url.search;
  }

  get hash(): string {
    if (this.#hash) this.#uses.url = true;
    return this.#url.hash;
  }

  get searchParams(): LoadSearchParams {
    return this.#searchParams;
  }
}

/** The `route` of a load: reading `id` is a dependency. */
export class LoadRoute {
  #id: string;
  #uses: Uses;

  constructor(id: string, uses: Uses) {
    this.#id = id;
    this.#uses = uses;
  }

  get id(): string {
    this.#uses.route = true;
    return this.#id;
  }
}

/** A parameter of a route id (`import('types').RouteParam`). */
export type ParamDef = {
  name: string;
  matcher: string | undefined;
  optional: boolean;
  rest: boolean;
  chained: boolean;
};

/**
 * utils/routing.js `exec`: the parameters of a match (its captures in
 * `values`), checked by their matchers; undefined when a matcher refuses.
 */
export function exec_params(
  values: (string | undefined)[],
  params: ParamDef[],
  matches: (matcher: string, value: string) => boolean,
): Map<string, string> | undefined {
  const result = new Map<string, string>();
  let needing = 0;
  for (const v of values) if (v !== undefined) needing += 1;
  let buffered = 0;
  for (let i = 0; i < params.length; i += 1) {
    const param = params[i];
    let value: string | undefined = i - buffered < values.length ? values[i - buffered] : undefined;
    if (param.chained && param.rest && buffered !== 0) {
      const parts: string[] = [];
      for (let k = i - buffered; k < i + 1 && k < values.length; k++) {
        const s = values[k];
        if (s) parts.push(s);
      }
      value = parts.join('/');
      buffered = 0;
    }
    if (value === undefined) {
      if (param.rest) value = '';
      else continue;
    }
    const matcher = param.matcher;
    if (matcher === undefined || matches(matcher, value)) {
      result.set(param.name, value);
      const next_param: ParamDef | undefined = i + 1 < params.length ? params[i + 1] : undefined;
      const next_value: string | undefined = i + 1 < values.length ? values[i + 1] : undefined;
      if (
        next_param !== undefined &&
        !next_param.rest &&
        next_param.optional &&
        next_value !== undefined &&
        next_value !== '' &&
        param.chained
      )
        buffered = 0;
      if (
        next_param === undefined &&
        (next_value === undefined || next_value === '') &&
        result.size === needing
      )
        buffered = 0;
      continue;
    }
    if (param.optional && param.chained) {
      buffered++;
      continue;
    }
    return undefined;
  }
  if (buffered !== 0) return undefined;
  return result;
}
