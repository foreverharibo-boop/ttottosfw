import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
const helper=fs.readFileSync(new URL('../scene-field-size.js',import.meta.url),'utf8').replaceAll('export function ','function ');
test('collected textarea grows, shrinks, follows edits, and remeasures after hidden/reopen or width change',()=>{
 let callback;const watched=new Set();
 const field={clientWidth:300,isConnected:true,visible:true,scrollHeight:40,style:{height:'40px'},listeners:{},
  getClientRects(){return this.visible?[{}]:[];},addEventListener(type,fn){this.listeners[type]=fn;},
  parentElement:{style:{minHeight:''},getBoundingClientRect:()=>({height:40})}};
 const context={document:{querySelectorAll:()=>[field]},getComputedStyle:()=>({borderTopWidth:'1px',borderBottomWidth:'1px'}),
  ResizeObserver:class {constructor(fn){callback=fn;}observe(node){watched.add(node);}unobserve(node){watched.delete(node);}}};
 vm.createContext(context);vm.runInContext(helper,context);context.autoSizeSceneFields();
 assert.equal(field.style.height,'42px');assert.equal(watched.size,1);
 field.scrollHeight=260;field.listeners.input();assert.equal(field.style.height,'262px');
 field.scrollHeight=24;field.listeners.input();assert.equal(field.style.height,'26px');
 field.visible=false;callback([{target:field}]);field.scrollHeight=180;field.visible=true;callback([{target:field}]);assert.equal(field.style.height,'182px');
 field.clientWidth=150;field.scrollHeight=360;callback([{target:field}]);assert.equal(field.style.height,'362px');
 assert.equal(field.parentElement.style.minHeight,'');
 field.isConnected=false;context.document.querySelectorAll=()=>[];context.autoSizeSceneFields();assert.equal(watched.size,0);
});
for(const kind of ['sfw','nsfw']) {
 const file=new URL(`../modes/${kind}/index.js`,import.meta.url);
 const standalone=new URL('../index.js',import.meta.url);
 if(!fs.existsSync(file)&&!fs.readFileSync(standalone,'utf8').includes(`const MODULE_NAME = 'ttotto-${kind}'`))continue;
 const source=fs.readFileSync(fs.existsSync(file)?file:standalone,'utf8');
 test(kind+': deployed state-only fields are multiline and wired to resizing without changing edit handlers',()=>{
  const start=source.indexOf('function renderStatePanel() {'),body=source.slice(start,source.indexOf('\n}',start));
  assert.ok(body.includes("document.createElement('textarea')"));assert.ok(!body.includes("input.type = 'text'"));
  assert.ok(body.includes("addEventListener('change'"));assert.match(source,/renderStatePanel\(\);\s*autoSizeSceneFields\(\);/);
  const html=fs.readFileSync(new URL(fs.existsSync(file)?`../modes/${kind}/settings.html`:'../settings.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/<input id="t[ns][sf]-state-[^"]+" type="text"/);
  assert.match(html,/<textarea id="t[ns][sf]-state-location"/);
 });
}
test('state textarea styles wrap and have no internal scrollbar or height cap',()=>{
 const css=fs.readFileSync(new URL('../scene-field-size.css',import.meta.url),'utf8');
 assert.match(css,/max-height: none/);assert.match(css,/overflow: hidden/);assert.match(css,/white-space: pre-wrap/);
});
