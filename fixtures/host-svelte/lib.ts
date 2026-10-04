// Routes of the hash router and a Fisher-Yates shuffle.
export type Route = { name: string; id: number };

/** `#/items/2` → { name: 'item', id: 2 }; `#/about`, `#/items`, `#/` and others. */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#/') ? hash.slice(2) : '';
  const parts = path.split('/');
  if (parts[0] === 'items' && parts.length > 1) return { name: 'item', id: Number(parts[1]) };
  if (parts[0] === 'items') return { name: 'items', id: 0 };
  if (parts[0] === 'about') return { name: 'about', id: 0 };
  if (parts[0] === '') return { name: 'home', id: 0 };
  return { name: 'missing', id: 0 };
}

export function shuffle(items: string[]): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}
