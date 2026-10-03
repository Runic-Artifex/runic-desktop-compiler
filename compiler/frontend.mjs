import { Diagnostic } from './collect.mjs';
import { lowerReact } from './adapters/react.mjs';
import { lowerVue } from './adapters/vue.mjs';
import { lowerSvelte } from './adapters/svelte.mjs';
export async function lower(graph, options = {}) {
  // RUNIC_PIPELINE=4 forces the TypeScript frontend (migration testing).
  if (process.env.RUNIC_PIPELINE) graph.config.pipeline = Number(process.env.RUNIC_PIPELINE);
  switch (graph.config.framework ?? 'react') {
    case 'react':
      if (graph.config.pipeline === 4) {
        const { lowerReact4 } = await import('../frontend/adapters/react.ts');
        return lowerReact4(graph, options);
      }
      return lowerReact(graph, options);
    case 'vue':
      if (graph.config.pipeline === 4) {
        const { lowerVue4 } = await import('../frontend/adapters/vue.ts');
        return lowerVue4(graph, options);
      }
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
