import { validateIR } from './ir.mjs';
import { hash } from './collect.mjs';

export function newIR(graph, name) {
  return {
    schema: 3,
    sourceHash: graph.hash,
    frontend: {
      adapter: name,
      version: 1,
      packages: graph.tooling.packages,
      tools: { vite: '8.3.2', typescript: '5.9.3' },
    },
    title: graph.config.title,
    states: [],
    handlers: [],
    ui: null,
    css: graph.css,
    assets: graph.assets,
    mappings: [],
    capabilities: ['dom', 'css', 'window', 'click', 'keyboard', 'finite-state'],
    provenance: graph.manifest,
  };
}
export function finishIR(ir) {
  if (ir.states.some(s => s.domain?.kind === 'text')) ir.capabilities.push('text-input');
  const result = validateIR(ir);
  ir.irHash = hash(ir);
  return result;
}
