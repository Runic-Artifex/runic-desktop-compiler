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
