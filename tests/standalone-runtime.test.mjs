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
    for(const file of ['slow-burn-turns.js','scene-body.js','body-tokens.js','compact-report.js']){
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
