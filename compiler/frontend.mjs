import {Diagnostic} from './collect.mjs';
import {lowerReact} from './adapters/react.mjs';
import {lowerVue} from './adapters/vue.mjs';
import {lowerSvelte} from './adapters/svelte.mjs';
export async function lower(graph,options={}) {
  switch(graph.config.framework??'react'){case 'react':return lowerReact(graph,options);case 'vue':return lowerVue(graph,options);case 'svelte':return lowerSvelte(graph,options);default:throw new Diagnostic('E_FRONTEND','Unsupported frontend '+graph.config.framework);}
}
