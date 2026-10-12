// Elements every adapter accepts beyond its own list (P1 in docs/GAPS.md):
// inert text-level and grouping elements, which have no behaviour of their
// own and render through the user-agent stylesheet (runic-ir's TAGS).

/** Text-level and grouping elements without behaviour (M6 breadth sweep). */
export const INERT_TAGS = [
  'sup',
  'sub',
  'kbd',
  'mark',
  'time',
  'abbr',
  's',
  'u',
  'cite',
  'dfn',
  'var',
  'samp',
  'ins',
  'del',
  'data',
  'blockquote',
  'address',
];

/** Table formatting is owned by Blitz; adapters only lower HTML structure. */
export const TABLE_TAGS = [
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'colgroup',
  'col',
];

/**
 * Form grouping: Blitz lays out the rendered legend over the fieldset's
 * border as Chromium does. A fieldset's `disabled` (which disables its
 * descendant controls outside its first legend) is not modelled, so it is
 * rejected (docs/gaps/PLATFORM.md).
 */
export const FIELDSET_TAGS = ['fieldset', 'legend'];

/** The diagnostic for `disabled` on a fieldset (`spread`: a spread that may hold it). */
export const FIELDSET_DISABLED = (spread: boolean) =>
  `${spread ? 'Spread attributes that may hold disabled' : 'disabled'} on <fieldset> are not supported: a disabled fieldset disables its descendant controls (outside its first legend), which the runtime does not model`;
