import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const isSfw = source.includes("const MODULE_NAME = 'ttotto-sfw'");
const moduleName = isSfw ? 'ttotto-sfw' : 'ttotto-nsfw';
const metaName = isSfw ? 'ttottoSfw' : 'ttottoNsfw';
function setup({ mode = 'express', apiSource = 'vertexai', withProfile = true } = {}) {
    const profile = { id: 'analysis', api: 'test-provider', model: 'selected-model', preset: 'saved-preset', 'secret-id': 'selected-secret' };
    const shared = { preset: { vertexai_auth_mode: 'full' }, main: { source: 'other-provider', max_tokens: 9000 } };
    const context = {
        chat: [{ mes: 'They discussed tomorrow.', is_user: false }],
        chatMetadata: { [metaName]: { chatSchemaVersion: 1, enabled: true } },
        extensionSettings: { [moduleName]: { settingsSchemaVersion: 4, enabled: true, adultConfirmed: true, refineProfileId: withProfile ? profile.id : '', refineVertexAuthMode: mode, autoRefine: false, slowBurnEnabled: false } },
        CONNECT_API_MAP: { 'test-provider': { selected: 'openai', source: apiSource } },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const calls = [];
    const service = {
        getProfile(id) { assert.equal(id, profile.id); return profile; },
        validateProfile(p) { return context.CONNECT_API_MAP[p.api]; },
        async sendRequest(id, prompt, tokens, options, overrides) {
            calls.push({ id, prompt, tokens, options, overrides });
            // Model the documented final override after the saved preset.
            const payload = { ...shared.preset, ...overrides };
            if (apiSource === 'vertexai' && payload.vertexai_auth_mode === 'full' && mode === 'express') throw new Error('Service Account JSON is required for Vertex AI Full mode');
            return { content: '{"location":"Home"}' };
        },
    };
    context.ConnectionManagerRequestService = service;
    let rawCalls = 0;
    context.generateRaw = async () => { rawCalls++; return 'raw response'; };
    const savedShared = JSON.stringify(shared);
    const savedProfile = JSON.stringify(profile);
    const env = { SillyTavern: { getContext: () => context }, URL, console: { log() {}, warn() {}, error() {}, debug() {} }, structuredClone,
        document: { getElementById: () => null }, window: {}, AbortController, setTimeout() {}, clearTimeout() {}, toastr: {} };
    vm.createContext(env);
    const script = source.slice(0, source.indexOf('const bootContext = getContext();'))
        .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
    vm.runInContext(script + '\nglobalThis.api={requestRefine,refineProfileOverrides};', env);
    return { context, service, calls, env, profile, shared, get rawCalls() { return rawCalls; },
        unchanged() { assert.equal(JSON.stringify(shared), savedShared); assert.equal(JSON.stringify(profile), savedProfile); } };
}
test('Express override reaches only the selected analysis request without changing a Full preset', async () => {
    const r = setup(); const controller = new AbortController();
    assert.equal(await r.env.api.requestRefine(controller.signal), '{"location":"Home"}');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].overrides.vertexai_auth_mode, 'express');
    assert.equal(r.calls[0].options.signal, controller.signal);
    assert.equal(r.calls[0].options.stream, false);
    assert.equal(r.calls[0].id, 'analysis');
    assert.equal(Object.keys(r.calls[0].overrides).length, 1);
    assert.equal(r.rawCalls, 0); r.unchanged();
});
test('Full selection remains supported for service-account users', async () => {
    const r = setup({ mode: 'full' }); await r.env.api.requestRefine();
    assert.equal(r.calls[0].overrides.vertexai_auth_mode, 'full'); r.unchanged();
});
for (const mode of ['profile', undefined, 'unknown']) test(`existing default does not override authentication: ${mode}`, async () => {
    const r = setup({ mode: 'profile' }); r.context.extensionSettings[moduleName].refineVertexAuthMode = mode;
    await r.env.api.requestRefine(); assert.equal(Object.keys(r.calls[0].overrides).length, 0); r.unchanged();
});
test('non-Vertex providers receive no Vertex override', async () => {
    const r = setup({ apiSource: 'openai' }); await r.env.api.requestRefine();
    assert.equal(Object.keys(r.calls[0].overrides).length, 0); r.unchanged();
});
test('current-connection generation keeps its existing route', async () => {
    const r = setup({ withProfile: false }); assert.equal(await r.env.api.requestRefine(), 'raw response');
    assert.equal(r.calls.length, 0); assert.equal(r.rawCalls, 1); r.unchanged();
});
test('legacy profile lookup uses stored profile metadata without changing it', async () => {
    const r = setup(); delete r.service.getProfile; delete r.service.validateProfile;
    r.context.extensionSettings.connectionManager = { profiles: [r.profile] };
    await r.env.api.requestRefine(); assert.equal(r.calls[0].overrides.vertexai_auth_mode, 'express'); r.unchanged();
});
