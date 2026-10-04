// Mapping pack for esm-env 1.2.2 (docs/design/M6-LIBRARIES.md, "Mapping
// packs"): environment constants that bits-ui reads (`BROWSER` in its roving
// focus group and portals). The package selects them by export conditions;
// a native application runs as a production browser build, which is what the
// conformance reference builds with Vite: `BROWSER` is true (the `browser`
// condition), `DEV` false (`production`), `NODE` false (no `node` condition
// in browser builds). They are constants folded where they are used.
import type { Pack } from '../packs.ts';

const LABEL = 'esm-env@1.2.2 pack';

const CONSTANTS: Record<string, boolean> = { BROWSER: true, DEV: false, NODE: false };

export const esmEnvPack: Pack = {
  name: 'esm-env',
  version: '1.2.2',
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    if (imported in CONSTANTS) return { kind: 'constant', value: CONSTANTS[imported] };
    return `${LABEL} covers BROWSER, DEV and NODE, not ${imported}`;
  },
};
