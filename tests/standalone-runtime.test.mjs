import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
const own = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url))).display_name.includes('NSFW') ? 'nsfw' : 'sfw';
const other = own === 'sfw' ? 'nsfw' : 'sfw';
const sources = { [own]: fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8') };
const peerPath = process.env[other.toUpperCase() + '_INDEX'];
if (peerPath) sources[other] = fs.readFileSync(peerPath, 'utf8');
const scene = { location:'방', time:'이야기 속 저녁', environment:'비', important_objects:{열쇠:'책상'},
    characters:{A:{appearance:'코트',position:'의자',holding:'컵',condition:'피곤함',contact:'없음'}},
    scene_type:'conversation', intensity:3, stage:3, acts:['계획을 상의함'], dialogue_beats:['질문'],
    dialogue_flow:{topic:'여행',last_question:'언제?',new_facts:['내일']}, next:['일정을 정함'] };
const wire=(heat=0,stage=5)=>({_v:2,scene:structuredClone(scene),heat,stage});
const report=(heat=0,tag='sfw_scene')=>`<${tag}>${JSON.stringify(wire(heat))}</${tag}>`;
const msg=(heat=0,tag='sfw_scene')=>({mes:'Reply.'+report(heat,tag),swipe_id:0,extra:{token_count:999}});
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function setup({ kinds=[own], mode='auto', slow=false, autoRefine=false, chat=[], savedMeta, legacyPeer=false }={}) {
    const prompts={}, timers=new Map(), events=new EventEmitter(); let timerId=0, calls=0,saves=0;
    const context={chat,chatId:'one',chatMetadata:savedMeta??{},extensionSettings:{}, eventSource:events,
        eventTypes:Object.fromEntries(['GENERATION_STARTED','MESSAGE_RECEIVED','GENERATION_ENDED','GENERATION_STOPPED','CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_DELETED','CHAT_CHANGED','CHAT_CREATED'].map(x=>[x,x])),
        setExtensionPrompt:(key,value)=>prompts[key]=value,saveSettingsDebounced(){},saveMetadataDebounced(){},saveChat(){saves++;},
        getTokenCountAsync:async text=>text.length,powerUserSettings:{message_token_count_enabled:true},
        generateRaw:async()=>{calls++;return JSON.stringify(wire(own==='nsfw'?8:0));}};
    for(const k of kinds) context.extensionSettings['ttotto-'+k]={enabled:true,adultConfirmed:true,settingsSchemaVersion:k==='sfw'?4:3,autoRefine,slowBurnEnabled:slow,slowBurnIntensity:'light',armMode:mode};
    if(legacyPeer) {context.extensionSettings['ttotto-'+other]={enabled:true,adultConfirmed:true,armMode:'auto'};context.chatMetadata[other==='sfw'?'ttottoSfw':'ttottoNsfw']={enabled:true};}
    const counter={textContent:'999t'};
    const element={getAttribute:()=> '0',querySelectorAll:()=>[counter]};
    const env={SillyTavern:{getContext:()=>context},URL,structuredClone,AbortController,
        document:{getElementById:()=>null,querySelector:()=>element},window:{},
        console:{log(){},debug(){},warn(){},error(){}},toastr:{success(){},info(){},warning(){},error(){}},
        setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);}};
    vm.createContext(env);
    for(const k of kinds){
        const script=sources[k].slice(0,sources[k].indexOf('const bootContext = getContext();')).replaceAll('export function ','function ').replaceAll('import.meta.url',"'file:///index.js'");
        vm.runInContext(`(()=>{${script}\nglobalThis.${k}={getSettings,getChatMeta,isFullyArmed,prepareSceneInjection,handleIncomingMessage,harvestMessage,effectiveState,buildInjection,buildSlowBurnLines,slowBurnProgress,startSlowBurnSessionIfNeeded,beginSceneGeneration,finishSceneGeneration,runRefine,refinePromptMessages,snapshotMatchesMessage,snapshotForMessage,registerEvents,onDisable,sharedCompactReport,receiveCompactRepair};})();`,env);
        env[k].getSettings();env[k].getChatMeta();env[k].registerEvents();
    }
    return {env,context,prompts,timers,counter,events,api:env[own], get calls(){return calls;},get saves(){return saves;},
        prepare(){for(const k of kinds)env[k].prepareSceneInjection({generationType:'normal'});},
        collect(i=chat.length-1){for(const k of kinds)env[k].handleIncomingMessage(i);}};
}
function combined(r){return Object.values(r.prompts).join('\n');}
function schemas(r){return [...combined(r).matchAll(/<(sfw_scene|scene_state)>({[^\n]+})<\/\1>/g)].map(m=>JSON.parse(m[2]));}

test('embedded shared helpers match their independently tested sources',()=>{
    for(const file of ['scene-field-size.js','scene-collection-sfw-ui.js','slow-burn-turns.js','scene-body.js','body-tokens.js','compact-report.js']){
        const embedded=sources[own].split(`// BEGIN ${file}\n`)[1].split(`\n// END ${file}`)[0];
        assert.equal(embedded,fs.readFileSync(new URL('../'+file,import.meta.url),'utf8').replaceAll('export function ','function '));
    }
});
test('standalone uses Korean compact records, preserves legacy records, and needs no peer',()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto',slow:true});r.prepare();
    assert.equal(schemas(r).length,1);assert.equal(schemas(r)[0]._v,2);
    assert.match(combined(r),/Korean only/);assert.doesNotMatch(combined(r),/English \|\||bilingual/);
    assert.match(r.api.refinePromptMessages()[0].content,/Korean only/);
    const m=msg(own==='nsfw'?8:0,own==='sfw'?'sfw_scene':'scene_state');r.context.chat.push(m);r.collect();
    assert.equal(r.api.effectiveState().state.location.ko,'방');assert.equal(m.mes,'Reply.');
    assert.equal(r.calls,0);
});
test('older enabled peer negotiates a readable legacy schema',()=>{
    const r=setup({legacyPeer:true,mode:own==='nsfw'?'manual':'auto'});r.prepare();
    assert.equal(schemas(r)[0]._v,undefined);assert.match(combined(r),/Korean only/);
    assert.doesNotMatch(combined(r),/bilingual/);
});
test('token recount follows removed reports and survives host rerender without touching provider usage',async()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto'}),m=msg(own==='nsfw'?8:0,own==='sfw'?'sfw_scene':'scene_state');
    m.extra.providerUsage={output:999};m.swipes=[m.mes];m.swipe_info=[{extra:{token_count:999,keep:7}}];r.context.chat.push(m);
    r.collect();await settle();assert.equal(m.extra.token_count,6);assert.equal(m.swipe_info[0].extra.token_count,6);assert.equal(m.swipe_info[0].extra.keep,7);assert.equal(m.extra.providerUsage.output,999);
    r.counter.textContent='999t';m.extra.token_count=999;r.api.handleIncomingMessage(0);await settle();assert.equal(r.counter.textContent,'6t');assert.equal(m.extra.token_count,6);
});
test('shared record follows swipe and body, tolerates foreign tag cleanup, rejects stale data',()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto'}),m=msg(own==='nsfw'?8:0);m.mes+='<custom>old</custom>';r.context.chat.push(m);r.collect();
    m.mes='Reply.';assert.equal(r.api.snapshotMatchesMessage(m),true);assert.ok(r.api.sharedCompactReport(m));
    m.mes='Changed.';assert.equal(r.api.snapshotMatchesMessage(m),false);assert.equal(r.api.sharedCompactReport(m),null);
    m.mes='Reply.';m.swipe_id=1;assert.equal(r.api.sharedCompactReport(m),null);
    m.swipe_id=0;m.mes='Reply.<sfw_scene>{broken';assert.equal(r.api.sharedCompactReport(m),null);
});
test('slow-burn completed session unlocks transition, but user lock still holds',()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto',slow:true});r.api.startSlowBurnSessionIfNeeded();
    const meta=r.api.getChatMeta();meta.slowBurnStageOverride=6;
    for(let i=0;i<12;i++){
        r.context.chat.push({is_user:true,mes:'Next',send_date:'user-'+i});
        const raw=wire(own==='nsfw'?8:0,6);raw.scene.stage=6;
        r.context.chat.push({mes:'Reply.'+`<${own==='sfw'?'sfw_scene':'scene_state'}>${JSON.stringify(raw)}</${own==='sfw'?'sfw_scene':'scene_state'}>`});r.collect();
    }
    assert.equal(r.api.slowBurnProgress().canConclude,true);
    const lines=r.api.buildSlowBurnLines(r.api.getSettings()).join('\n');assert.match(lines,/COMPLETION PERMITTED/);assert.doesNotMatch(lines,/Do not skip|ABSOLUTE NO-CONCLUSION/);
    meta.slowBurnLocked=true;assert.equal(r.api.slowBurnProgress().canConclude,false);assert.match(r.api.buildSlowBurnLines(r.api.getSettings()).join('\n'),/STAGE LOCKED/);
});
test('analysis cannot overwrite records after main generation starts with unchanged body',async()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto'}),m=msg(own==='nsfw'?8:0);r.context.chat.push(m);r.collect();
    let release;r.context.generateRaw=()=>new Promise(resolve=>release=resolve);
    const job=r.api.runRefine({manual:true});await settle();assert.ok(release);
    r.api.beginSceneGeneration('continue',true);assert.equal(await job,false);r.api.finishSceneGeneration('continue');
    release(JSON.stringify({...wire(8),scene:{...scene,location:'STALE'}}));await settle();assert.doesNotMatch(JSON.stringify(m.extra),/STALE/);
});
test('analysis cannot overwrite a concurrent local manual edit',async()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto'}),m=msg(own==='nsfw'?8:0);r.context.chat.push(m);r.collect();
    let release;r.context.generateRaw=()=>new Promise(resolve=>release=resolve);
    const job=r.api.runRefine({manual:true});await settle();r.api.getChatMeta().manualState={state:{location:{ko:'수동'}},at:123,source:'manual'};
    release(JSON.stringify(wire(8)));assert.equal(await job,false);assert.equal(r.api.getChatMeta().manualState.state.location.ko,'수동');
});
for(const order of [['sfw','nsfw'],['nsfw','sfw']])test(`paired compact report makes a round trip in ${order.join(' -> ')} order`,{skip:!peerPath},()=>{
    const r=setup({kinds:order});r.prepare();assert.equal(schemas(r).length,1);assert.equal(schemas(r)[0].heat,0);assert.equal(schemas(r)[0].stage,undefined);
    let m=msg(8);r.context.chat.push(m);r.collect();assert.equal(r.env.nsfw.isFullyArmed(),true);assert.equal(m.mes,'Reply.');assert.equal(r.env.nsfw.effectiveState().state.location.ko,'방');
    r.prepare();assert.equal(schemas(r).length,1);assert.equal(r.prompts.ttotto_sfw_continuity,'');assert.match(r.prompts.ttotto_nsfw_continuity,/열쇠/);assert.match(r.prompts.ttotto_nsfw_continuity,/이야기 속 저녁/);
    m=msg(0,'scene_state');r.context.chat.push({is_user:true,mes:'They return to everyday conversation.'},m);r.collect();
    assert.equal(r.env.nsfw.isFullyArmed(),false);assert.equal(r.env.sfw.isFullyArmed(),true);assert.equal(r.env.sfw.effectiveState().state.importantObjects.열쇠.ko,'책상');assert.equal(m.mes,'Reply.');
    r.prepare();assert.equal(schemas(r).length,1);assert.match(r.prompts.ttotto_sfw_continuity,/열쇠/);assert.equal(r.calls,0);
    const reload=setup({kinds:order,chat:JSON.parse(JSON.stringify(r.context.chat)),savedMeta:JSON.parse(JSON.stringify(r.context.chatMetadata))});reload.collect();assert.equal(reload.env.sfw.effectiveState().state.location.ko,'방');
});
test('paired repeated harvests do not rewrite unchanged shared records', {skip:!peerPath},()=>{
    const r=setup({kinds:['nsfw','sfw']}),m=msg(0);r.context.chat.push(m);r.collect();
    const first=m.extra.ttottoSfw.swipes['0'];const second=m.extra.ttottoNsfw.swipes['0'];
    for(let i=0;i<10;i++)r.collect();assert.equal(m.extra.ttottoSfw.swipes['0'],first);assert.equal(m.extra.ttottoNsfw.swipes['0'],second);
});
test('paired repair synchronizes both views, with no second API request',{skip:!peerPath},async()=>{
    const r=setup({kinds:['sfw','nsfw']});r.context.chat.push({mes:'Reply.'});r.context.generateRaw=async()=>JSON.stringify(wire(0));
    assert.equal(await r.env.sfw.runRefine({manual:true}),true);assert.equal(r.env.nsfw.effectiveState().state.heat,0);assert.equal(r.env.sfw.effectiveState().state.location.ko,'방');
});
test('peer manual edit invalidates outstanding shared repair',{skip:!peerPath},async()=>{
    const r=setup({kinds:['sfw','nsfw']});r.context.chat.push(msg(0));r.collect();let release;r.context.generateRaw=()=>new Promise(resolve=>release=resolve);
    const job=r.env.sfw.runRefine({manual:true});await settle();r.env.nsfw.getChatMeta().manualState={state:{heat:0},at:55,source:'manual'};
    release(JSON.stringify(wire(0)));assert.equal(await job,false);assert.equal(r.env.nsfw.getChatMeta().manualState.at,55);
});
test('disabled peer stops shared monitor requests and preserves standalone operation',{skip:!peerPath},()=>{
    const r=setup({kinds:['nsfw','sfw']});r.env.nsfw.onDisable();r.env.sfw.prepareSceneInjection({generationType:'normal'});
    assert.equal(schemas(r).length,1);assert.equal(schemas(r)[0].heat,undefined);
});
test('paired differing optional settings retain the return report fields without adding SFW pacing',{skip:!peerPath},()=>{
    const r=setup({kinds:['nsfw','sfw']});r.context.extensionSettings['ttotto-nsfw'].nextBeatHints=false;
    r.context.extensionSettings['ttotto-nsfw'].dialogueBeatGuard=false;r.context.chat.push(msg(8));r.collect();r.prepare();
    assert.equal(schemas(r).length,1);assert.ok(schemas(r)[0].scene.next);assert.ok(schemas(r)[0].scene.dialogue_beats);assert.equal(r.prompts.ttotto_sfw_continuity,'');
});
test('partial report during main generation cannot be saved through common-state access',()=>{
    const r=setup({mode:own==='nsfw'?'manual':'auto'}),m=msg(own==='nsfw'?8:0);r.context.chat.push(m);
    r.api.beginSceneGeneration('normal',true);assert.equal(r.api.sharedCompactReport(m),null);assert.equal(m.extra.ttottoCompactScene,undefined);
    r.api.finishSceneGeneration('normal');r.collect();assert.ok(m.extra.ttottoCompactScene);
});

test('SFW collection off removes descriptions but preserves intensity, stages and histories without repair',async()=>{
 const r=setup({slow:true,autoRefine:true});r.api.getSettings().sceneCollection={enabled:false};r.prepare();
 const schema=schemas(r)[0].scene;assert.equal(schema.location,undefined);assert.equal(schema.characters,undefined);
 assert.equal(schema.intensity,0);assert.equal(schema.stage,1);assert.ok(schema.acts);
 const m=msg();r.context.chat.push(m);r.collect();
 assert.equal(r.api.effectiveState().state.location,undefined);assert.equal(r.api.effectiveState().state.intensity,3);
 assert.doesNotMatch(JSON.stringify(m.extra),/코트|이야기 속 저녁|피곤함/);
 assert.equal(r.timers.size,0);assert.equal(r.calls,0);
 r.prepare();assert.doesNotMatch(combined(r),/코트|이야기 속 저녁|피곤함/);
 assert.equal(await r.api.runRefine({manual:true}),true);assert.equal(r.calls,1);
 assert.doesNotMatch(JSON.stringify(m.extra),/코트|이야기 속 저녁|피곤함/);
});
test('SFW selected facts filter old snapshots and restore on re-enable, including legacy schemas',()=>{
 const r=setup(),m=msg();r.context.chat.push(m);r.collect();const before=JSON.stringify(m.extra);
 r.api.getSettings().sceneCollection={fields:{time:false,appearance:false}};r.prepare();
 assert.doesNotMatch(combined(r),/코트|이야기 속 저녁/);assert.match(combined(r),/의자/);
 assert.equal(JSON.stringify(m.extra),before);
 r.api.getSettings().sceneCollection={};r.prepare();assert.match(combined(r),/코트/);
 const old=setup({legacyPeer:true});old.api.getSettings().sceneCollection={enabled:false};old.prepare();
 assert.equal(schemas(old)[0].location,undefined);assert.equal(schemas(old)[0]._v,undefined);
 assert.doesNotMatch(old.api.refinePromptMessages()[0].content,/"location"|"appearance"/);
});

test('CardInject reply and candidate purposes are independent; disabled source categories still work once',()=>{
 const r=setup({mode:own==='nsfw'?'manual':'auto'});
 r.context.characterId=0;r.context.characters=[{name:'A',avatar:'a.png'},{name:'A',avatar:'b.png'}];r.context.name1='Reader';
 r.context.extensionSettings.cardinject={perChar:{'a.png':{categories:[{key:'selected',name:'Traits',enabled:false,content:'{{char}} CARD_REFERENCE_MARKER {{user}}'},{key:'other',name:'Other',enabled:true,content:'UNSELECTED_CARD_MARKER'}]},'b.png':{categories:[{key:'selected',name:'Traits',enabled:false,content:'OTHER_CHARACTER_MARKER'}]}}};
 const settings=r.api.getSettings();Object.assign(settings,{cardLinkEnabled:true,cardLinkSelected:{'a.png':['selected']}});
 assert.equal(settings.cardLinkUseReply,true);assert.equal(settings.cardLinkUseNext,true);
 for(const reply of [false,true])for(const next of [false,true])for(const hints of [false,true]){
  Object.assign(settings,{cardLinkUseReply:reply,cardLinkUseNext:next,nextBeatHints:hints});r.prepare();
  const prompt=combined(r);assert.equal((prompt.match(/CARD_REFERENCE_MARKER/g)??[]).length,reply||next&&hints?1:0);
  assert.equal(prompt.includes('CHARACTER SHEET CONTEXT'),reply);
  assert.doesNotMatch(prompt,/UNSELECTED_CARD_MARKER|OTHER_CHARACTER_MARKER|\{\{char\}\}/);
  assert.equal(JSON.stringify(r.api.refinePromptMessages()).includes('CARD_REFERENCE_MARKER'),next&&hints);
 }
 assert.equal(r.calls,0);
 Object.assign(settings,{cardLinkUseReply:true,cardLinkUseNext:true,nextBeatHints:true});
 r.context.characterId=1;r.prepare();assert.doesNotMatch(combined(r),/CARD_REFERENCE_MARKER|OTHER_CHARACTER_MARKER/);
 r.context.characterId=0;settings.cardLinkEnabled=false;r.prepare();assert.doesNotMatch(combined(r),/CARD_REFERENCE_MARKER/);
 settings.cardLinkEnabled=true;settings.enabled=false;r.prepare();assert.doesNotMatch(combined(r),/CARD_REFERENCE_MARKER/);
});
test('reply-only CardInject is omitted from legacy auxiliary prompts and remains during a target scene',()=>{
 const r=setup({mode:own==='nsfw'?'manual':'auto',legacyPeer:true});
 r.context.characterId=0;r.context.characters=[{name:'A',avatar:'a.png'}];
 r.context.extensionSettings.cardinject={perChar:{'a.png':{categories:[{key:'t',name:'Traits',enabled:false,content:'TARGET_CARD_MARKER'}]}}};
 const settings=r.api.getSettings();Object.assign(settings,{cardLinkEnabled:true,cardLinkSelected:{'a.png':['t']},cardLinkUseReply:true,cardLinkUseNext:false,nextBeatHints:false});
 r.prepare();assert.match(combined(r),/TARGET_CARD_MARKER/);assert.doesNotMatch(JSON.stringify(r.api.refinePromptMessages()),/TARGET_CARD_MARKER/);
 Object.assign(settings,{developerMode:true,cardLinkUseNext:true,nextBeatHints:true});
 const meta=r.api.getChatMeta();Object.assign(meta,{slowBurnTargetActive:true,slowBurnTarget:'TARGET_ACTION',slowBurnSessionActive:true});
 r.prepare();assert.match(combined(r),/TARGET_CARD_MARKER/);assert.doesNotMatch(JSON.stringify(r.api.refinePromptMessages()),/TARGET_CARD_MARKER/);
});

for (const legacyPeer of [false, true]) test(`record language controls main and auxiliary schemas, including legacy=${legacyPeer}`, () => {
 const r=setup({mode:own==='nsfw'?'manual':'auto',legacyPeer,slow:true});
 const settings=r.api.getSettings();
 for(const language of ['ko','en','ko'])for(const enabled of [true,false]){
  settings.sceneCollection={language,enabled};r.prepare();
  const expected=language==='en'?'English only':'Korean only',excluded=language==='en'?'Korean only':'English only';
  assert.ok(combined(r).includes(expected));assert.ok(!combined(r).includes(excluded));
  assert.doesNotMatch(combined(r),/[가-힣]/,'built-in instructions must not inject Korean labels');
  const system=r.api.refinePromptMessages()[0].content;assert.ok(system.includes(expected));assert.ok(!system.includes(excluded));assert.doesNotMatch(system,/[가-힣]/);
 }
});
test('changing record language keeps old Korean history and preserves new English values for display and reinjection',()=>{
 const r=setup({mode:own==='nsfw'?'manual':'auto'}),old=msg(own==='nsfw'?8:0);
 r.context.chat.push(old);r.collect();const before=JSON.stringify(old.extra);
 r.api.getSettings().sceneCollection={language:'en'};r.prepare();assert.match(combined(r),/English only/);assert.match(combined(r),/코트/);assert.equal(JSON.stringify(old.extra),before);
 const raw=wire(own==='nsfw'?8:0);raw.scene.location='Living room';raw.scene.characters.A.appearance='A blue coat';
 const tag=own==='sfw'?'sfw_scene':'scene_state',m={mes:'New reply.'+`<${tag}>${JSON.stringify(raw)}</${tag}>`,swipe_id:0,extra:{}};
 r.context.chat.push(m);r.collect();r.prepare();
 assert.equal(r.api.effectiveState().state.location.ko,'Living room','display getter preserves English text');
 assert.match(combined(r),/Living room/);assert.match(combined(r),/A blue coat/);
 r.api.getSettings().sceneCollection.language='ko';r.prepare();assert.match(combined(r),/Korean only/);assert.match(combined(r),/Living room/);
 assert.equal(JSON.stringify(old.extra),before);assert.equal(r.calls,0);
});
test('record language governs the actual auxiliary request and returned values',async()=>{
 const r=setup({mode:own==='nsfw'?'manual':'auto'});r.context.chat.push(msg(own==='nsfw'?8:0));r.collect();
 r.api.getSettings().sceneCollection={language:'en'};let request;
 r.context.generateRaw=async args=>{request=args;const raw=wire(own==='nsfw'?8:0);raw.scene.location='English repair location';return JSON.stringify(raw);};
 assert.equal(await r.api.runRefine({manual:true}),true);assert.match(JSON.stringify(request),/English only/);assert.doesNotMatch(JSON.stringify(request),/Korean only/);
 assert.equal(r.api.effectiveState().state.location.ko,'English repair location');r.prepare();assert.match(combined(r),/English repair location/);
});
for(const kind of ['sfw','nsfw'])test(`paired ${kind} record language follows the authoring mode`,{skip:!peerPath},()=>{
 const r=setup({kinds:['sfw','nsfw'],mode:kind==='nsfw'?'manual':'stealth'});
 r.env.sfw.getSettings().sceneCollection={language:'ko'};r.env.nsfw.getSettings().sceneCollection={language:'en'};r.prepare();
 const prompt=r.env[kind].buildInjection();assert.match(prompt,kind==='sfw'?/Korean only/:/English only/);
 assert.doesNotMatch(prompt,kind==='sfw'?/English only/:/Korean only/);
});
