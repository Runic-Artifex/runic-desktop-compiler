// `{@html}` (M6, docs/design/M6-SVELTEKIT.md, phase 2): HTML is parsed at
// build time, never at run time. Each string that can reach a `{@html}` is
// a program fragment (`Program.fragments`): the string and its nodes, parsed
// as Svelte's `html()` parses it (a `<template>` element's innerHTML, the
// HTML fragment parsing algorithm, here parse5). The native runtime only
// selects the fragment whose string is the value.
//
// The strings: a constant (the markdown preprocessor's highlighted code),
// or, for any other value, the strings of the build-time data tables
// (server data, prerendered endpoints' responses). A value outside them is
// reported unsupported at run time.
//
// Fragments hold static, non-interactive elements only: no links, controls,
// scripts, styles or SVG (which would need the template rules for them), and
// no event handler attributes.
import { parseFragment } from 'parse5';
import type { Fragment, FragmentNode } from './ir.ts';

/** The elements a fragment may hold. */
export const FRAGMENT_TAGS = new Set([
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'main',
  'article',
  'section',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'small',
  'b',
  'i',
  'code',
  'pre',
  'br',
  'hr',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
]);

/** The program's fragments, by string. */
export class Fragments {
  readonly list: Fragment[] = [];
  private readonly index = new Map<string, number>();

  /** The fragment of `html` (parsed once); throws a message when it holds what fragments cannot. */
  add(html: string): number {
    const known = this.index.get(html);
    if (known !== undefined) return known;
    const nodes = parseHtml(html);
    this.list.push({ html, nodes });
    this.index.set(html, this.list.length - 1);
    return this.list.length - 1;
  }
}

/** The nodes of an HTML fragment, checked (throws an Error naming what is unsupported). */
export function parseHtml(html: string): FragmentNode[] {
  type P5 = {
    nodeName: string;
    tagName?: string;
    value?: string;
    attrs?: { name: string; value: string }[];
    childNodes?: P5[];
    namespaceURI?: string;
  };
  const convert = (n: P5): FragmentNode | undefined => {
    if (n.nodeName === '#text') return { text: n.value ?? '' };
    if (n.nodeName === '#comment') return undefined;
    const tag = n.tagName ?? n.nodeName;
    if (n.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !FRAGMENT_TAGS.has(tag))
      throw new Error(`<${tag}> is outside the elements {@html} content may hold`);
    const attrs: [string, string][] = [];
    for (const a of n.attrs ?? []) {
      if (!/^[a-z][a-z0-9_-]*$/.test(a.name) || a.name.startsWith('on'))
        throw new Error(`the attribute ${a.name} on <${tag}> is unsupported in {@html} content`);
      attrs.push([a.name, a.value]);
    }
    const children = (n.childNodes ?? []).map(convert).filter((c): c is FragmentNode => !!c);
    return {
      tag,
      ...(attrs.length ? { attrs } : {}),
      ...(children.length ? { children } : {}),
    };
  };
  const doc = parseFragment(html) as unknown as P5;
  return (doc.childNodes ?? []).map(convert).filter((c): c is FragmentNode => !!c);
}
