// `page` of `$app/state` (SvelteKit 2.70.1, src/runtime/client/state.svelte.js
// and src/runtime/app/state/client.js): reactive fields the router writes,
// read through getters. `page.data`, `page.form` and `page.state` are not
// provided (docs/CONTRACT.md "SvelteKit").
import { Params } from './params.ts';
import { KitURL } from './url.ts';

export type KitRoute = { id: string | null };
/** `App.Error`. */
export type KitError = { message: string };

/** What `update(page)` assigns (Kit's page object). */
export type PageValue = {
  error: KitError | null;
  params: Params;
  route: KitRoute;
  status: number;
  url: KitURL;
};

/** The router's page state (`state.svelte.js`'s `page`). */
export class PageState {
  error = $state.raw<KitError | null>(null);
  params = $state.raw(new Params());
  route = $state.raw<KitRoute>({ id: null });
  status = $state.raw(-1);
  url = $state.raw(new KitURL('/'));

  /** `update(new_page)`: `Object.assign(page, new_page)`. */
  update(p: PageValue) {
    this.error = p.error;
    this.params = p.params;
    this.route = p.route;
    this.status = p.status;
    this.url = p.url;
  }
}

export const internal = new PageState();

/** `$app/state`'s `page`: getters over the router's state. */
export class Page {
  get error(): KitError | null {
    return internal.error;
  }
  get params(): Params {
    return internal.params;
  }
  get route(): KitRoute {
    return internal.route;
  }
  get status(): number {
    return internal.status;
  }
  get url(): KitURL {
    return internal.url;
  }
}

export const page = new Page();
