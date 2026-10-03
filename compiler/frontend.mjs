// Framework adapters (frontend/adapters/*.ts) on the shared language layer.
// Every lowered program is validated by the Rust backend before it is used.
import { Diagnostic } from './collect.mjs';
import { check } from './codegen.mjs';

export async function lower(graph) {
  const result = await adapter(graph);
  // The document element starts with index.html's <html> attributes.
  if (Object.keys(graph.documentAttrs ?? {}).length) result.ir.document = graph.documentAttrs;
  check(result.ir);
  return result;
}

async function adapter(graph) {
  switch (graph.config.framework ?? 'react') {
    case 'react': {
      const { lowerReact } = await import('../frontend/adapters/react.ts');
      return lowerReact(graph);
    }
    case 'vue': {
      const { lowerVue } = await import('../frontend/adapters/vue.ts');
      return lowerVue(graph);
    }
    case 'svelte': {
      const { lowerSvelte } = await import('../frontend/adapters/svelte.ts');
      return lowerSvelte(graph);
    }
    default:
      throw new Diagnostic('E_FRONTEND', 'Unsupported frontend ' + graph.config.framework);
  }
}
