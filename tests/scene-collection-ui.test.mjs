import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
test('SFW collection checkboxes default on, save, and keep individual choices through a master toggle',()=>{
 const nodes=new Map(),settings={};let saves=0;
 const ids=['enabled','location','time','environment','objects','appearance','position','holding','condition'];
 for(const key of ids)nodes.set(key==='enabled'?'tsf-scene-collection-enabled':'tsf-scene-collect-'+key,{addEventListener(_,fn){this.change=fn;}});
 const box={getSettings:()=>settings,getContext:()=>({saveSettingsDebounced(){saves++;}}),element:id=>nodes.get(id),clearInjectedPrompt(){},updateUi(){box.renderSceneCollectionUi();}};
 vm.createContext(box);vm.runInContext(fs.readFileSync(new URL('../compact-report.js',import.meta.url),'utf8').replaceAll('export function ','function ')+fs.readFileSync(new URL('../scene-collection-sfw-ui.js',import.meta.url),'utf8'),box);
 box.renderSceneCollectionUi();box.bindSceneCollectionUi();
 const time=nodes.get('tsf-scene-collect-time'),master=nodes.get('tsf-scene-collection-enabled');
 assert.equal(time.checked,true);time.checked=false;time.change();master.checked=false;master.change();
 assert.equal(time.disabled,true);master.checked=true;master.change();assert.equal(time.checked,false);assert.equal(time.disabled,false);assert.equal(saves,3);
 const html=fs.readFileSync(new URL('../settings.html',import.meta.url),'utf8');for(const id of nodes.keys())assert.ok(html.includes('id="'+id+'"'));
 const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');const start=source.indexOf('function updateUi() {');assert.match(source.slice(start,source.indexOf('\n}',start)),/renderSceneCollectionUi\(\)/);
});
