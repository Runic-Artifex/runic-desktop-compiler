import { Diagnostic } from './collect.mjs';
import { lowerReact } from './adapters/react.mjs';
import { lowerVue } from './adapters/vue.mjs';
import { lowerSvelte } from './adapters/svelte.mjs';
export async function lower(graph, options = {}) {
  switch (graph.config.framework ?? 'react') {
    case 'react':
      return lowerReact(graph, options);
    case 'vue':
      return lowerVue(graph, options);
    case 'svelte':
      // Pipeline 4: the TypeScript frontend on the shared language layer (M2).
      if (graph.config.pipeline === 4) {
        const { lowerSvelte4 } = await import('../frontend/adapters/svelte.ts');
        return lowerSvelte4(graph, options);
      }
      return lowerSvelte(graph, options);
    default:
      throw new Diagnostic('E_FRONTEND', 'Unsupported frontend ' + graph.config.framework);
  }
}
