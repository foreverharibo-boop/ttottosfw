import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function runtime(enabled = true) {
    const prompts = {}, calls = [];
    const settings = { enabled: true, diagnosticsEnabled: enabled, autoRefine: false, slowBurnEnabled: false };
    const context = {
        chat: [], chatMetadata: { ttottoSfw: { chatSchemaVersion: 1, enabled: true } },
        extensionSettings: { 'ttotto-sfw': settings },
        setExtensionPrompt(key, value) { prompts[key] = value; },
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, saveChat() {},
    };
    const response = { status: 200, ok: true, text() { throw new Error('diagnostics must not read response body'); } };
    const promise = Promise.resolve(response);
    const original = function (...args) { calls.push({ args, receiver: this }); return promise; };
    const env = {
        SillyTavern: { getContext: () => context }, URL, Request, AbortController, structuredClone,
        location: { href: 'http://localhost:8000/', origin: 'http://localhost:8000' }, fetch: original,
        document: { getElementById: () => null }, window: {},
        console: { log() {}, warn() {}, error() {}, debug() {} }, toastr: { info() {}, success() {}, warning() {} },
        setTimeout() { return 1; }, clearTimeout() {},
    };
    vm.createContext(env);
    const script = source.slice(0, source.indexOf('const bootContext = getContext();'))
        .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
    vm.runInContext(script + '\nglobalThis.api={getSettings,syncDiagnosticFetch,stopDiagnosticFetch,diagnosticRecord,diagnosticReport,clearDiagnostics,handleIncomingMessage,prepareSceneInjection};', env);
    env.api.getSettings();
    return { env, api: env.api, context, settings, prompts, calls, original, response, promise,
        report: () => JSON.parse(env.api.diagnosticReport()), rows: () => JSON.parse(env.api.diagnosticReport()).events };
}
const state = { location: 'PRIVATE ROOM', characters: { PRIVATE_NAME: { appearance: 'PRIVATE CLOTHES', position: 'Standing' } }, acts: ['PRIVATE ACT'], intensity: 1, next: ['Rest'] };
const stateTag = `<sfw_scene>${JSON.stringify(state)}</sfw_scene>`;
test('disabled diagnostics do not install a fetch hook or retain collection events', () => {
    const r = runtime(false); r.api.syncDiagnosticFetch(); r.context.chat.push({ mes: stateTag });
    r.api.handleIncomingMessage(0);
    assert.equal(r.env.fetch, r.original); assert.equal(r.rows().length, 0);
    assert.ok(r.context.chat[0].extra.ttottoSfw.swipes['0'].state.characters.PRIVATE_NAME);
});
test('registered prompt, observed request, parsed tag and saved characters are independently recorded', async () => {
    const r = runtime(); r.api.syncDiagnosticFetch(); r.api.prepareSceneInjection({ generationType: 'normal' });
    const init = { method: 'POST', body: JSON.stringify({ messages: [{ role: 'system', content: r.prompts.ttotto_sfw_continuity }], api_key: 'PRIVATE_KEY' }) };
    const p = r.env.fetch('/api/backends/chat-completions/generate', init);
    assert.equal(p, r.promise); assert.equal(await p, r.response);
    assert.equal(r.calls[0].args[1], init);
    r.context.chat.push({ mes: 'PRIVATE BODY\n' + stateTag }); r.api.handleIncomingMessage(0);
    const rows = r.rows();
    assert.ok(rows.some(e => e.stage === 'injection_registered' && e.data.reportInstruction));
    assert.ok(rows.some(e => e.stage === 'request_observed' && e.data.reportInstruction));
    assert.ok(rows.some(e => e.stage === 'response_observed' && e.data.reason === 'parsed_tag' && e.data.characters === 1));
    assert.ok(rows.some(e => e.stage === 'collection_result' && e.data.wrote));
    assert.ok(!r.context.chat[0].mes.includes('<sfw_scene>'));
    const report = r.api.diagnosticReport();
    for (const secret of ['PRIVATE_KEY', 'PRIVATE BODY', 'PRIVATE_NAME', 'PRIVATE ROOM', 'PRIVATE CLOTHES', 'PRIVATE ACT']) assert.ok(!report.includes(secret), secret);
    assert.equal(r.context.chatMetadata.ttottoSfwDiagnostics, undefined);
});
for (const [body, reason] of [['Just ordinary text.', 'missing_tag'], ['<sfw_scene>{', 'unclosed_tag'], ['<sfw_scene>{bad}</sfw_scene>', 'invalid_json'], ['<sfw_scene>{}</sfw_scene>', 'empty_state']]) {
    test(`collection distinguishes ${reason} without enabling automatic refinement`, () => {
        const r = runtime(); r.context.chat.push({ mes: body }); r.api.handleIncomingMessage(0);
        assert.ok(r.rows().some(e => e.stage === 'response_observed' && e.data.reason === reason));
        assert.ok(r.rows().some(e => e.stage === 'refine_skipped' && e.data.reason === 'auto_refine_off'));
        assert.equal(r.calls.length, 0); assert.equal(r.settings.autoRefine, false);
    });
}
test('NSFW delegation is visible instead of being diagnosed as parse failure', () => {
    const r = runtime(); r.context.extensionSettings['ttotto-nsfw'] = { enabled: true };
    r.env.ttottoNsfwSceneBridge = { sync: () => true };
    r.context.chat.push({ mes: stateTag }); r.api.handleIncomingMessage(0);
    assert.ok(r.rows().some(e => e.stage === 'collection_skipped' && e.data.reason === 'nsfw_owner'));
    assert.equal(r.context.chat[0].extra?.ttottoSfw, undefined);
});
test('opaque bodies and missing report instructions remain distinct', async () => {
    const r = runtime(); r.api.syncDiagnosticFetch();
    await r.env.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: 'not JSON' });
    await r.env.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [{ content: 'Private text without instructions' }] }) });
    const rows = r.rows().filter(e => e.stage === 'request_observed');
    assert.equal(rows[0].data.readable, false); assert.equal(rows[1].data.reportInstruction, false);
});
test('unrelated and external requests are not inspected', async () => {
    const r = runtime(); r.api.syncDiagnosticFetch();
    await r.env.fetch('/api/secrets/read', { body: 'PRIVATE_KEY' });
    await r.env.fetch('https://example.com/api/backends/chat-completions/generate', { body: 'PRIVATE_KEY' });
    assert.equal(r.calls.length, 2); assert.equal(r.rows().length, 0);
});
test('disabling restores our own wrapper but preserves a later foreign wrapper', async () => {
    const r = runtime(); r.api.syncDiagnosticFetch(); const wrapper = r.env.fetch;
    const foreign = (...args) => wrapper(...args); r.env.fetch = foreign;
    r.settings.diagnosticsEnabled = false; r.api.syncDiagnosticFetch();
    assert.equal(r.env.fetch, foreign);
    await r.env.fetch('/api/backends/chat-completions/generate', { body: '{}' });
    assert.equal(r.rows().length, 0);
    r.settings.diagnosticsEnabled = true; r.api.syncDiagnosticFetch();
    assert.equal(r.env.fetch, foreign);
    await r.env.fetch('/api/backends/chat-completions/generate', { body: '{}' });
    assert.ok(r.rows().some(e => e.stage === 'request_observed'));
    r.env.fetch = wrapper; r.settings.diagnosticsEnabled = false; r.api.syncDiagnosticFetch();
    assert.equal(r.env.fetch, r.original);
});
test('logs are bounded, deduplicated and do not resurrect after clearing an in-flight request', async () => {
    const r = runtime();
    for (let i = 0; i < 200; i++) r.api.diagnosticRecord('test', { message: i });
    assert.equal(r.rows().length, 150);
    r.api.diagnosticRecord('test', { message: 199 }); assert.equal(r.rows().at(-1).repeats, 2);
    r.api.syncDiagnosticFetch(); const promise = r.env.fetch('/api/backends/chat-completions/generate', { body: '{}' });
    r.api.clearDiagnostics(); await promise; assert.equal(r.rows().length, 0);
});
test('Request object body is observed through a clone and remains usable by the original fetch', async () => {
    const r = runtime(); r.api.syncDiagnosticFetch();
    const request = new Request('http://localhost:8000/api/backends/chat-completions/generate', { method: 'POST', body: '{"messages":[]}' });
    await r.env.fetch(request);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), '{"messages":[]}');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(r.rows().some(e => e.stage === 'request_observed' && e.data.readable));
});

test('post-save mismatch reports saved characters and normalized lengths without exposing text', () => {
    const r = runtime();
    r.context.chat.push({ mes: 'PRIVATE BODY\n' + stateTag });
    r.api.handleIncomingMessage(0);
    const saved = r.rows().find(e => e.stage === 'collection_result').data;
    assert.equal(saved.saved, true);
    assert.equal(saved.cached, true);
    assert.equal(saved.bodyChars, saved.savedBodyChars);
    assert.equal(saved.savedCharacters, 1);
    r.context.chat[0].mes = 'CHANGED PRIVATE BODY';
    r.api.handleIncomingMessage(0);
    const invalid = r.rows().find(e => e.stage === 'cache_invalidated').data;
    assert.equal(invalid.reason, 'body_signature_mismatch');
    assert.equal(invalid.saved, true);
    assert.equal(invalid.cached, false);
    assert.equal(invalid.savedCharacters, 1);
    assert.notEqual(invalid.bodyChars, invalid.savedBodyChars);
    for (const text of ['PRIVATE BODY', 'PRIVATE_NAME', 'PRIVATE ROOM', 'PRIVATE ACT']) assert.ok(!r.api.diagnosticReport().includes(text));
});
