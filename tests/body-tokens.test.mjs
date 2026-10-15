import test from 'node:test';
import assert from 'node:assert/strict';
import { createBodyTokenCounter } from '../body-tokens.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
    const message = { mes: 'Visible reply. <foreign>keep</foreign>', swipe_id: 0,
        extra: { token_count: 999, display_text: 'Existing translation', reasoning: 'Hidden reasoning' },
        swipes: ['Visible reply. <foreign>keep</foreign>', 'Other reply'],
        swipe_info: [{ extra: { token_count: 999, keep: 'first' } }, { extra: { token_count: 77 } }] };
    let finish, fail, calls = 0, saves = 0, generation = 0, active = true, blocked = false;
    const events = [], counter = { textContent: '999t' };
    let domSwipe = '0';
    globalThis.document = { querySelector: () => ({ getAttribute: () => domSwipe, querySelectorAll: () => [counter] }) };
    const context = { chat: [message], chatId: 'chat-a', chatMetadata: {}, powerUserSettings: { message_token_count_enabled: true },
        getTokenCountAsync: (text, padding) => { calls++; assert.equal(text, message.mes); assert.equal(padding, 0); return new Promise((resolve,reject) => { finish=resolve;fail=reject; }); } };
    const tokens = createBodyTokenCounter({raw:()=>context,ready:()=>active,allowed:()=>!blocked,epoch:()=>generation,
        swipe:m=>m.swipe_id??0,save:()=>saves++,record:(...args)=>events.push(args)});
    return {message,context,tokens,counter,events,resolve:n=>finish(n),reject:()=>fail(new Error('private error')),
        calls:()=>calls,saves:()=>saves,nextGeneration:()=>generation++,stop:()=>{active=false;},block:()=>{blocked=true;},domSwipe:v=>{domSwipe=v;}};
}
test('count cleaned body, persist active swipe only and update counter without replacing translation', async()=>{
    const r=setup();r.tokens.cleaned(r.message);await settle();r.resolve(12);await settle();
    assert.equal(r.message.extra.token_count,12);assert.equal(r.message.swipe_info[0].extra.token_count,12);
    assert.equal(r.message.swipe_info[1].extra.token_count,77);assert.equal(r.message.swipe_info[0].extra.keep,'first');
    assert.equal(r.message.extra.display_text,'Existing translation');assert.equal(r.message.extra.reasoning,'Hidden reasoning');
    assert.equal(r.counter.textContent,'12t');assert.equal(r.saves(),1);
    for(let i=0;i<20;i++)r.tokens.refresh(r.message);
    assert.equal(r.calls(),1);assert.equal(r.saves(),1);
    // The host may render/create swipe metadata after our MESSAGE_RECEIVED handler.
    r.counter.textContent='999t';r.message.swipe_info[0].extra.token_count=999;
    r.tokens.refresh(r.message);assert.equal(r.counter.textContent,'12t');assert.equal(r.message.swipe_info[0].extra.token_count,12);
});
for(const reason of ['chat','metadata','chat-id','message','body','swipe','extra','generation','disabled','blocked','setting-off','reset']) {
    test(`discard stale token calculation: ${reason}`,async()=>{
        const r=setup();r.tokens.cleaned(r.message);await settle();
        switch(reason){
            case 'chat':r.context.chat=[r.message];break;
            case 'metadata':r.context.chatMetadata={};break;
            case 'chat-id':r.context.chatId='other';break;
            case 'message':r.context.chat[0]={...r.message};break;
            case 'body':r.message.mes+=' changed';break;
            case 'swipe':r.message.swipe_id=1;break;
            case 'extra':r.message.extra={...r.message.extra};break;
            case 'generation':r.nextGeneration();break;
            case 'disabled':r.stop();break;
            case 'blocked':r.block();break;
            case 'setting-off':r.context.powerUserSettings.message_token_count_enabled=false;break;
            case 'reset':r.tokens.reset();break;
        }
        r.resolve(12);await settle();assert.equal(r.message.extra.token_count,999);assert.equal(r.saves(),0);assert.equal(r.counter.textContent,'999t');
    });
}
test('a newer generation can recount after an old calculation was discarded',async()=>{
    const r=setup();r.tokens.cleaned(r.message);await settle();r.nextGeneration();r.resolve(12);await settle();
    r.tokens.refresh(r.message);await settle();r.resolve(24);await settle();assert.equal(r.message.extra.token_count,24);
});
test('failed/invalid tokenizer result preserves previous count, can retry, and accepts zero',async()=>{
    const r=setup();r.tokens.cleaned(r.message);await settle();r.reject();await settle();assert.equal(r.message.extra.token_count,999);
    r.tokens.refresh(r.message);await settle();r.resolve(NaN);await settle();assert.equal(r.message.extra.token_count,999);
    r.tokens.refresh(r.message);await settle();r.resolve(0);await settle();assert.equal(r.counter.textContent,'0t');assert.equal(r.saves(),1);
    assert.equal(JSON.stringify(r.events).includes('private error'),false);
});
test('unowned messages, disabled display and missing tokenizer do not recount',async()=>{
    const r=setup();r.tokens.refresh(r.message);await settle();assert.equal(r.calls(),0);
    r.context.powerUserSettings.message_token_count_enabled=false;r.tokens.cleaned(r.message);await settle();assert.equal(r.calls(),0);
    r.context.powerUserSettings.message_token_count_enabled=true;delete r.context.getTokenCountAsync;r.tokens.refresh(r.message);await settle();assert.equal(r.calls(),0);
});
test('do not change a different displayed swipe or mismatching stored swipe text',async()=>{
    const r=setup();r.domSwipe('1');r.message.swipes[0]='Old body';r.tokens.cleaned(r.message);await settle();r.resolve(12);await settle();
    assert.equal(r.counter.textContent,'999t');assert.equal(r.message.swipe_info[0].extra.token_count,999);assert.equal(r.message.extra.token_count,12);
});
