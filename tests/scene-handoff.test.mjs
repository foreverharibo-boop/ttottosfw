import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const sfwSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const nsfwPath = process.env.NSFW_INDEX;
const nsfwSource = nsfwPath ? fs.readFileSync(nsfwPath, 'utf8') : null;
const sfwReport = {
    location: 'Hotel', time: '9:45 PM', environment: 'Clear',
    characters: { A: { appearance: 'Coat', position: 'Sofa', holding: 'Water', condition: 'Tired' } },
    acts: ['Discussed tomorrow'], intensity: 2, next: ['Rest'],
};
const plainBody = '주머니에 폰을 쑤셔 넣고 욕실로 걸어갔다.';
const panel = '<Info_panel>\n[Date: 2024.11.09. (토) | 09:45 PM]\n[Weather: 맑음 | 5°C]\n[Location: 도심 비즈니스 호텔 스위트룸]\n</Info_panel>';
const msg = (mes, is_user = false) => ({ mes, is_user });
const heatTag = heat => `<scene_state>{"heat":${heat}}</scene_state>`;
const stateTag = state => `<sfw_scene>${JSON.stringify(state)}</sfw_scene>`;

function setup({ installed = true, paired = false, owner = false, mode = 'auto', autoRefine = false, chat = [], suspended = false, loadOrder = 'nsfw-first' } = {}) {
    const prompts = {};
    const timers = new Map();
    let timerId = 0, requests = 0;
    const foreign = { preset: ['A', 'B'], maxTokens: 12345, extension: { enabled: true } };
    const before = JSON.stringify(foreign);
    const context = {
        chat, chatMetadata: {
            ttottoSfw: { chatSchemaVersion: 1, enabled: true, nsfwSuspended: suspended },
            ttottoNsfw: { chatSchemaVersion: 1, enabled: true, autoArmed: owner, sfwImmediateHandoff: !owner },
        },
        extensionSettings: { 'ttotto-sfw': { settingsSchemaVersion: 3, enabled: true, autoRefine, slowBurnEnabled: false } },
        setExtensionPrompt(key, text) { prompts[key] = text; },
        saveMetadataDebounced() {}, saveSettingsDebounced() {}, saveChat() {}, foreign,
        generateRaw: async () => { requests++; return JSON.stringify(sfwReport); },
    };
    if (installed) context.extensionSettings['ttotto-nsfw'] = {
        settingsSchemaVersion: 3, enabled: true, adultConfirmed: true, armMode: mode,
        autoRefine: false, slowBurnEnabled: false, stealthSensitivity: 'normal',
    };
    const env = {
        SillyTavern: { getContext: () => context }, URL, structuredClone, AbortController,
        console: { log() {}, warn() {}, error() {}, debug() {} },
        toastr: { info() {}, warning() {}, success() {}, error() {} },
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        document: { getElementById: () => null }, window: {},
    };
    vm.createContext(env);
    const load = (source, name, exports) => {
        const script = source.slice(0, source.indexOf('const bootContext = getContext();'))
            .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
        vm.runInContext(`(function(){${script}\nglobalThis.${name}={${exports}};})();`, env);
    };
    const sfw = () => load(sfwSource, 'sfw', 'getSettings,getChatMeta,scoreScene,syncNsfwSuspension,isFullyArmed,handleIncomingMessage,effectiveState,prepareSceneInjection,runRefine,finishReceivedGeneration,beginSceneGeneration,finishSceneGeneration');
    const nsfw = () => load(nsfwSource, 'nsfw', 'getSettings,getChatMeta,handleIncomingMessage,isFullyArmed,prepareSceneInjection,finishReceivedGeneration,beginSceneGeneration,finishSceneGeneration');
    if (paired) {
        if (loadOrder === 'sfw-first') { sfw(); nsfw(); } else { nsfw(); sfw(); }
        env.nsfw.getSettings(); env.nsfw.getChatMeta();
    } else {
        if (installed) env.ttottoNsfwSceneBridge = { sync: () => owner };
        sfw();
    }
    env.sfw.getSettings(); env.sfw.getChatMeta();
    return { env, context, prompts, timers, get requests() { return requests; },
        meta: context.chatMetadata.ttottoSfw,
        unchanged: () => assert.equal(JSON.stringify(foreign), before) };
}

test('standalone Korean everyday actions are not sexual evidence', () => {
    for (const body of [plainBody, '폰만 보지 말고 빨리 내려.', '카드를 단말기에 삽입했다.', '샤워를 하며 비누로 가슴을 문지르고 헹궜다.']) {
        const r = setup({ installed: false, chat: [msg(body)] });
        assert.equal(r.env.sfw.scoreScene(body).score, 0, body);
        assert.equal(r.env.sfw.syncNsfwSuspension(), false);
    }
});
test('inline standalone detector matches exported detector', async () => {
    const source = fs.readFileSync(new URL('../scene-detector.js', import.meta.url), 'utf8');
    const { scoreScene } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const r = setup({ installed: false });
    for (const body of [plainBody, 'He licked her nipples.', 'He did not lick her nipples.', 'She showered.']) {
        assert.equal(JSON.stringify(r.env.sfw.scoreScene(body)), JSON.stringify(scoreScene(body)));
    }
});
test('NSFW idle owns the decision even when local words or custom keywords score high', () => {
    const r = setup({ chat: [msg('He licked her nipples.' + stateTag(sfwReport))] });
    r.context.extensionSettings['ttotto-nsfw'].stealthKeywords = 'He';
    assert.equal(r.env.sfw.syncNsfwSuspension(), false);
    r.env.sfw.handleIncomingMessage(0);
    r.env.sfw.prepareSceneInjection({ generationType: 'normal' });
    assert.ok(r.prompts.ttotto_sfw_continuity.includes('[Scene'));
    assert.equal(r.env.sfw.effectiveState().state.location.en, 'Hotel');
    r.unchanged();
});
test('disabled NSFW does not let SFW invent an independent paired owner', () => {
    const r = setup({ chat: [msg('He licked her nipples.')] });
    r.context.extensionSettings['ttotto-nsfw'].enabled = false;
    assert.equal(r.env.sfw.syncNsfwSuspension(), false);
});
test('standalone SFW still pauses for unambiguous sexual action', () => {
    const r = setup({ installed: false, chat: [msg('He licked her nipples.')] });
    assert.equal(r.env.sfw.syncNsfwSuspension(), true);
    assert.equal(r.env.sfw.isFullyArmed(), false);
});
test('actual NSFW ownership suppresses SFW collection and auxiliary calls', () => {
    const r = setup({ owner: true, autoRefine: true, chat: [msg(plainBody + stateTag(sfwReport))] });
    r.env.sfw.handleIncomingMessage(0);
    assert.equal(r.meta.nsfwSuspended, true);
    assert.equal(r.timers.size, 0);
    assert.equal(r.context.chat[0].extra?.ttottoSfw, undefined);
    r.unchanged();
});
function staleResume(autoRefine) {
    const old = msg('Old reply <Info_panel>[Date: 09:28 PM]</Info_panel>');
    old.extra = { ttottoNsfw: { swipes: { '0': { state: { heat: 0 } } } } };
    return setup({ suspended: true, autoRefine, chat: [old, msg('Rest here.', true), msg(plainBody + panel)] });
}
test('resume never copies an old heat-only report and uses latest explicit panel', () => {
    const r = staleResume(false);
    r.env.sfw.handleIncomingMessage(2);
    const { state, source } = r.env.sfw.effectiveState();
    assert.equal(source, 'nsfw-resume');
    assert.ok(state.time.ko.includes('09:45 PM'));
    assert.equal(state.location.ko, '도심 비즈니스 호텔 스위트룸');
    assert.equal(state.intensity, null);
    assert.equal(r.meta.manualState, null);
    assert.equal(r.timers.size, 0);
    assert.equal(r.requests, 0);
});
test('legacy handoff on an already resumed chat is repaired without another reply', () => {
    const r = staleResume(false);
    r.meta.nsfwSuspended = false;
    r.meta.manualState = { source: 'nsfw-handoff', at: Date.now(), state: { heat: 0, time: '09:28 PM' } };
    r.env.sfw.syncNsfwSuspension();
    assert.equal(r.meta.manualState, null);
    assert.equal(r.meta.nsfwResumePending, true);
    assert.ok(r.env.sfw.effectiveState().state.time.en.includes('09:45 PM'));
});
test('resume with current complete tag needs no extra analysis', () => {
    const r = staleResume(true);
    r.context.chat[2].mes += stateTag(sfwReport);
    r.env.sfw.handleIncomingMessage(2);
    assert.equal(r.meta.nsfwResumePending, false);
    assert.equal(r.env.sfw.effectiveState().source, 'tag');
    assert.equal(r.timers.size, 0);
});
test('enabled recovery analyzes and stores the latest selected reply once', async () => {
    const r = staleResume(true);
    r.env.sfw.handleIncomingMessage(2);
    r.env.sfw.handleIncomingMessage(2);
    assert.equal(r.timers.size, 1);
    assert.equal(await r.env.sfw.runRefine(), true);
    assert.equal(r.requests, 1);
    assert.equal(r.meta.nsfwResumePending, false);
    assert.equal(r.env.sfw.effectiveState().source, 'ai-refine');
    assert.ok(r.context.chat[2].extra.ttottoSfw.swipes['0'].state.time.ko.includes('09:45 PM'));
    assert.equal(r.context.chat[0].extra.ttottoSfw, undefined);
    r.unchanged();
});
test('failed recovery stays pending and does not endlessly retry', async () => {
    const r = staleResume(true);
    let calls = 0;
    r.context.generateRaw = async () => { calls++; throw new Error('Offline'); };
    r.env.sfw.handleIncomingMessage(2);
    assert.equal(await r.env.sfw.runRefine(), false);
    r.env.sfw.syncNsfwSuspension();
    r.env.sfw.handleIncomingMessage(2);
    assert.equal(r.meta.nsfwResumePending, true);
    assert.equal(calls, 1);
    assert.equal(r.timers.size, 0);
    assert.ok(r.env.sfw.effectiveState().state.time.en.includes('09:45 PM'));
});
test('NSFW legacy metadata works without the bridge API', () => {
    const r = setup({ owner: true });
    delete r.env.ttottoNsfwSceneBridge;
    assert.equal(r.env.sfw.syncNsfwSuspension(), true);
    r.context.chatMetadata.ttottoNsfw.autoArmed = false;
    r.context.chatMetadata.ttottoNsfw.sfwImmediateHandoff = true;
    assert.equal(r.env.sfw.syncNsfwSuspension(), false);
});

for (const loadOrder of ['sfw-first', 'nsfw-first']) {
    test(`paired NSFW-first release preserves the SFW report: ${loadOrder}`, { skip: !nsfwSource }, () => {
        const r = setup({ paired: true, owner: true, loadOrder, suspended: true, chat: [msg('We returned home.', true), msg(plainBody + panel + heatTag(0) + stateTag(sfwReport))] });
        r.env.nsfw.handleIncomingMessage(1);
        assert.ok(r.context.chat[1].mes.includes('<sfw_scene>'));
        r.env.sfw.handleIncomingMessage(1);
        assert.equal(r.env.nsfw.isFullyArmed(), false);
        assert.equal(r.env.sfw.isFullyArmed(), true);
        assert.equal(r.env.sfw.effectiveState().source, 'tag');
        assert.ok(r.env.sfw.effectiveState().state.time.en.includes('09:45 PM'));
        r.unchanged();
    });
    test(`paired idle temperature-zero reply retains SFW ownership: ${loadOrder}`, { skip: !nsfwSource }, () => {
        const r = setup({ paired: true, loadOrder, chat: [msg(plainBody + panel + heatTag(0) + stateTag(sfwReport))] });
        r.env.sfw.handleIncomingMessage(0);
        r.env.nsfw.handleIncomingMessage(0);
        assert.equal(r.env.nsfw.isFullyArmed(), false);
        assert.equal(r.env.sfw.isFullyArmed(), true);
        assert.ok(r.env.sfw.effectiveState().state.time.en.includes('09:45 PM'));
        r.env.sfw.prepareSceneInjection({ generationType: 'normal' });
        r.env.nsfw.prepareSceneInjection({ generationType: 'normal' });
        assert.ok(r.prompts.ttotto_sfw_continuity.includes('[Scene Continuity'));
        assert.ok(r.prompts.ttotto_nsfw_continuity.includes('[Scene Monitor]'));
        assert.ok(!r.prompts.ttotto_nsfw_continuity.includes('[Scene Continuity'));
        r.unchanged();
    });
    test(`paired completed high report handled first by SFW delegates correctly: ${loadOrder}`, { skip: !nsfwSource }, () => {
        const r = setup({ paired: true, loadOrder, chat: [msg('Current scene.' + heatTag(6) + stateTag(sfwReport))] });
        r.env.sfw.handleIncomingMessage(0);
        assert.equal(r.env.nsfw.isFullyArmed(), true);
        assert.equal(r.meta.nsfwSuspended, true);
        assert.equal(r.context.chat[0].extra?.ttottoSfw, undefined);
        assert.equal(r.context.chat[0].extra.ttottoNsfw.swipes['0'].state.heat, 6);
        r.unchanged();
    });
    test(`paired active -> ordinary zero -> SFW resumes without old snapshot: ${loadOrder}`, { skip: !nsfwSource }, () => {
        const r = setup({ paired: true, owner: true, loadOrder, suspended: true, chat: [msg('We returned home.', true), msg(plainBody + panel + heatTag(0) + stateTag(sfwReport))] });
        r.env.sfw.handleIncomingMessage(1);
        assert.equal(r.env.nsfw.isFullyArmed(), false);
        assert.equal(r.env.sfw.isFullyArmed(), true);
        assert.equal(r.env.sfw.effectiveState().source, 'tag');
        assert.ok(r.env.sfw.effectiveState().state.time.en.includes('09:45 PM'));
        r.unchanged();
    });
}
