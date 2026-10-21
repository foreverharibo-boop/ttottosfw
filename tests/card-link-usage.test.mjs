import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
for(const kind of ['sfw','nsfw']) {
 const generated=new URL(`../modes/${kind}/index.js`,import.meta.url),standalone=new URL('../index.js',import.meta.url);
 const path=fs.existsSync(generated)?generated:standalone,source=fs.readFileSync(path,'utf8');
 if(!fs.existsSync(generated)&&!source.includes(`const MODULE_NAME = 'ttotto-${kind}'`))continue;
 const prefix=kind==='sfw'?'tsf':'tns';
 test(kind+': both purpose checkboxes render saved settings and bind independently',()=>{
  const node=()=>({children:[],checked:false,append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},addEventListener(type,fn){this[type]=fn;}});
  const nodes=new Map(),element=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const settings={cardLinkEnabled:true,cardLinkUseReply:false,cardLinkUseNext:true,nextBeatHints:true,cardLinkSelected:{'a.png':['x']}};let saves=0;
  const start=source.indexOf('function renderCardLinkPanel(settings) {'),renderer=source.slice(start,source.indexOf('\n}',start)+2);
  const bindStart=source.indexOf('function bindSetting('),bind=source.slice(bindStart,source.indexOf('\n}',bindStart)+2);
  const bindings=source.split('\n').filter(line=>line.includes(`bindSetting('${prefix}-card-link-`)&&line.includes('cardLinkUse')).join('\n');
  const env={element,document:{createElement:node},getSettings:()=>settings,saveSettings(){saves++;},clearInjectedPrompt(){},updateUi(){},cardLinkOptions:()=>({available:true,rows:[{charKey:'a.png',charName:'A',catKey:'x',name:'Traits',content:'TEXT',ciEnabled:false}]})};
  vm.createContext(env);vm.runInContext(renderer+'\n'+bind+'\n'+bindings,env);env.renderCardLinkPanel(settings);
  assert.equal(element(prefix+'-card-link-reply').checked,false);assert.equal(element(prefix+'-card-link-next').checked,true);
  const reply=element(prefix+'-card-link-reply');reply.type='checkbox';reply.checked=true;reply.change();assert.equal(settings.cardLinkUseReply,true);assert.equal(settings.cardLinkUseNext,true);assert.equal(saves,1);
  const html=fs.readFileSync(new URL(fs.existsSync(generated)?`../modes/${kind}/settings.html`:'../settings.html',import.meta.url),'utf8');for(const suffix of ['reply','next'])assert.ok(html.includes(`id="${prefix}-card-link-${suffix}"`));
 });
}
