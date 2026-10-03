import {collect} from '../compiler/collect.mjs';
import {startComparison} from '../compiler/compare.mjs';
import {out,apps,versions,additional} from './phase4-common.mjs';
for(const [i,name]of apps.entries())await startComparison(await collect('fixtures/'+name),{port:5300+i,out:out+'/browser/'+name});
for(const v of versions)await startComparison(await collect(additional(v)),{port:v.port,out:out+'/browser/modules-'+v.framework+'-'+v.version});
console.log('Run /?runicCase=0 at 420x600 and 800x600 for current frontends; additional versions at 800x600.');
