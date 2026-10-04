// Prop domains (docs/design/M6-LIBRARIES.md#prop-domains): the finite set of
// values each component prop receives from its instantiation sites, a
// whole-program analysis in the shared language layer.
//
// Calls evaluated at build time (frontend/packs/choice.ts) need every
// argument to range over a finite set of exact values. A wrapper component
// such as shadcn's Button passes its `class` prop, typed as an open
// `ClassValue`, to `cn(buttonVariants({ variant, size }), className)`. The
// values are finite in the program: every site that instantiates Button
// passes a literal, a conditional between literals, a value of a
// literal-union type, a pack call over such values, or the prop of an
// enclosing component, whose own sites are finite in turn. The analysis
// collects, for each prop and each site, the set of values the site's
// expression can produce (`valueSet`, the same syntax and types as the
// choice mechanism, without building IR; an absent or undefined value takes
// the prop's fallback). A prop's domain is the union over its sites.
//
// Code size: a choice over the union of all sites' values multiplies the
// domains of the props a call reads (variants × sizes × classes across the
// whole program). Instead, every instance of a component with several sites
// gets a hidden `$site` prop holding the index of the site that created it
// (a constant the parent passes), and a call reading site-dependent props
// is enumerated per site, over that site's values only, behind a test of
// the index. The combinations then add up over the sites; a site that
// passes constants contributes one leaf.
//
// A prop the component itself writes (an assignment, a `bind:` directive)
// has no domain: its values do not all come from the sites. Neither does a
// prop of a component instantiated where the analysis cannot see the values
// (a spread). Open values stay rejected (E_PACK) where a call needs them.
import ts from 'typescript';
import type { Expr } from './ir.ts';
import type { FnBuilder, Lowerer } from './language.ts';
import { distinct, valueSet } from './packs/choice.ts';

/** A declared prop of a component (a destructured `$props()` binding). */
export interface PropDecl {
  /** The component (the adapter's index). */
  component: number;
  /** The prop's name at instantiation sites. */
  key: string;
  /** The local binding. */
  symbol: ts.Symbol;
  /** The fallback expression used for an absent or undefined value (none: undefined). */
  fallback?: ts.Expression;
  /** The component writes the prop (it then has no domain). */
  written: boolean;
}

/** What an instantiation site passes for a prop. */
export type SiteValue =
  | { expr: ts.Expression }
  | { value: unknown }
  /** Values the analysis cannot see (a spread, text mixed with expressions). */
  | { open: true };

/** One place that instantiates a component, with the values it passes by prop name. */
export interface Site {
  component: number;
  values: Map<string, SiteValue>;
  /** Where the site is (for diagnostics). */
  at?: { file: string; line: number; column: number };
}

/** The interface the language layer and the choice mechanism use (`Lowerer.domains`). */
export interface DomainHook {
  /**
   * The values `sym` (a prop) takes: at the fixed site while one is fixed
   * for its component, otherwise across all its sites; undefined when it has
   * no finite domain.
   */
  values(sym: ts.Symbol): unknown[] | undefined;
  /** Why the prop `sym` has no finite domain (undefined if it is not a prop or has one). */
  explain(sym: ts.Symbol): string | undefined;
  /** The component whose prop with a domain `sym` is. */
  componentOf(sym: ts.Symbol): number | undefined;
  /** How many sites instantiate `component`. */
  sites(component: number): number;
  /** The expression reading the instance's site index (creating its `$site` prop). */
  siteRead(component: number, b: FnBuilder): Expr;
  /** The site being enumerated, while a call is split by site. */
  site?: { component: number; index: number };
}

export class PropDomains implements DomainHook {
  private readonly lower: Lowerer;
  private readonly decls = new Map<ts.Symbol, PropDecl>();
  private readonly byComponent = new Map<number, Site[]>();
  private readonly union = new Map<ts.Symbol, unknown[] | undefined>();
  private readonly perSite = new Map<ts.Symbol, Map<number, unknown[] | undefined>>();
  private readonly inProgress = new Set<ts.Symbol>();
  private readonly read: (component: number, b: FnBuilder) => Expr;
  site?: { component: number; index: number };

  constructor(
    lower: Lowerer,
    decls: PropDecl[],
    sites: Site[],
    read: (component: number, b: FnBuilder) => Expr,
  ) {
    this.lower = lower;
    for (const d of decls) this.decls.set(d.symbol, d);
    for (const s of sites) {
      let list = this.byComponent.get(s.component);
      if (!list) this.byComponent.set(s.component, (list = []));
      list.push(s);
    }
    this.read = read;
  }

  /** The index of `site` among its component's sites. */
  indexOf(site: Site): number {
    return this.byComponent.get(site.component)?.indexOf(site) ?? -1;
  }

  sites(component: number): number {
    return this.byComponent.get(component)?.length ?? 0;
  }

  siteRead(component: number, b: FnBuilder): Expr {
    return this.read(component, b);
  }

  componentOf(sym: ts.Symbol): number | undefined {
    const d = this.decls.get(sym);
    return d && !d.written ? d.component : undefined;
  }

  values(sym: ts.Symbol): unknown[] | undefined {
    const d = this.decls.get(sym);
    if (!d || d.written) return undefined;
    if (this.site?.component === d.component) return this.at(d, this.site.index);
    return this.all(d);
  }

  explain(sym: ts.Symbol): string | undefined {
    const d = this.decls.get(sym);
    if (!d) return undefined;
    if (d.written)
      return `the prop ${d.key} is assigned by its component, so its values do not all come from its instantiation sites`;
    const sites = this.byComponent.get(d.component) ?? [];
    for (let i = 0; i < sites.length; i++)
      if (!this.at(d, i)) {
        const at = sites[i].at;
        return `the prop ${d.key} takes an open value at an instantiation site${at ? ` (${at.file}:${at.line}:${at.column})` : ''}`;
      }
    return undefined;
  }

  /** The union over all sites (undefined if any site's values are open). */
  all(d: PropDecl): unknown[] | undefined {
    if (this.union.has(d.symbol)) return this.union.get(d.symbol);
    const sites = this.byComponent.get(d.component) ?? [];
    let out: unknown[] | undefined = sites.length ? [] : undefined;
    for (let i = 0; out && i < sites.length; i++) {
      const s = this.at(d, i);
      out = s && [...out, ...s];
    }
    const result = out && distinct(out);
    this.union.set(d.symbol, result);
    return result;
  }

  /** The values site `index` of the prop's component passes for it. */
  at(d: PropDecl, index: number): unknown[] | undefined {
    let known = this.perSite.get(d.symbol);
    if (!known) this.perSite.set(d.symbol, (known = new Map()));
    if (known.has(index)) return known.get(index);
    // A cycle (a component instantiated inside its own sites' arguments)
    // has no finite domain.
    if (this.inProgress.has(d.symbol)) return undefined;
    this.inProgress.add(d.symbol);
    let out: unknown[] | undefined;
    try {
      const site = this.byComponent.get(d.component)![index];
      const passed = site.values.get(d.key);
      let values: unknown[] | undefined;
      if (!passed) values = [undefined];
      else if ('open' in passed) values = undefined;
      else if ('value' in passed) values = [passed.value];
      else values = valueSet({ lower: this.lower, label: 'prop domains' }, passed.expr);
      // An absent or undefined value takes the fallback.
      if (values && d.fallback && values.includes(undefined)) {
        const fallback = valueSet({ lower: this.lower, label: 'prop domains' }, d.fallback);
        values = fallback && [...values.filter(v => v !== undefined), ...fallback];
      }
      out = values && distinct(values);
    } finally {
      this.inProgress.delete(d.symbol);
    }
    known.set(index, out);
    return out;
  }
}
