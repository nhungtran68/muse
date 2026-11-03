import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const shared=new URL('../shared/storyboard.mjs',import.meta.url).href;
const legacy=new URL('../worker/muse-adapter.mjs',import.meta.url).href;
function bounded(module,expression){
  return execFileSync(process.execPath,['--input-type=module','-e',`const module=await import(${JSON.stringify(module)});const result=${expression};if(result!==null)process.exit(2);`],{timeout:3000,windowsHide:true,stdio:'pipe'});
}
test('streamed incomplete JSON at offset zero returns promptly in both storyboard parsers',()=>{
  const partial=JSON.stringify('{"id":"MARK",');
  assert.doesNotThrow(()=>bounded(shared,`module.parseMarkedJson(${partial},'MARK')`));
  const job='01234567-89ab-cdef-0123-456789abcdef',marker='PLAN_'+job.replaceAll('-','_');
  assert.doesNotThrow(()=>bounded(legacy,`module.parseScenePlan(${JSON.stringify('{"id":"'+marker+'","scenes":[')},${JSON.stringify(job)},3)`));
});
test('a complete unrelated JSON object containing the marker never spins at offset zero',()=>{
  assert.doesNotThrow(()=>bounded(shared,`module.parseMarkedJson(${JSON.stringify('{"id":"other","note":"MARK"}')},'MARK')`));
});
