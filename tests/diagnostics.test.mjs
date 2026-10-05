import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function runtime(enabled = true, suppliedResponse = null) {
    const prompts = {}, calls = [];
    const settings = { enabled: true, diagnosticsEnabled: enabled, autoRefine: false, slowBurnEnabled: false };
    const context = {
        chat: [], chatMetadata: { ttottoSfw: { chatSchemaVersion: 1, enabled: true } },
        extensionSettings: { 'ttotto-sfw': settings },
        setExtensionPrompt(key, value) { prompts[key] = value; },
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, saveChat() {},
    };
    const response = suppliedResponse ?? { status: 200, ok: true, text() { throw new Error('diagnostics must not read response body'); } };
    const promise = Promise.resolve(response);
    const original = function (...args) { calls.push({ args, receiver: this }); return promise; };
    const env = {
        SillyTavern: { getContext: () => context }, URL, Request, Response, TextDecoder, AbortController, structuredClone,
        location: { href: 'http://localhost:8000/', origin: 'http://localhost:8000' }, fetch: original,
        document: { getElementById: () => null }, window: {},
        console: { log() {}, warn() {}, error() {}, debug() {} }, toastr: { info() {}, success() {}, warning() {} },
        setTimeout() { return 1; }, clearTimeout() {},
    };
    vm.createContext(env);
    const script = source.slice(0, source.indexOf('const bootContext = getContext();'))
        .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
    vm.runInContext(script + '\nglobalThis.api={getSettings,syncDiagnosticFetch,stopDiagnosticFetch,diagnosticRecord,diagnosticReport,clearDiagnostics,handleIncomingMessage,prepareSceneInjection,diagnosticInspectResponse,diagnosticTrackBody,diagnosticWriteTrace};', env, { filename: 'http://localhost:8000/scripts/extensions/third-party/ttottosfw/index.js' });
    env.api.getSettings();
    return { env, api: env.api, context, settings, prompts, calls, original, response, promise,
        report: () => JSON.parse(env.api.diagnosticReport()), rows: () => JSON.parse(env.api.diagnosticReport()).events };
}
const state = { location: 'PRIVATE ROOM', characters: { PRIVATE_NAME: { appearance: 'PRIVATE CLOTHES', position: 'Standing' } }, acts: ['PRIVATE ACT'], intensity: 1, next: ['Rest'] };
const stateTag = `<sfw_scene>${JSON.stringify(state)}</sfw_scene>`;
test('40-character post-collection deletion identifies the writer and stage invalidation without dialogue', () => {
    const r = runtime(); r.settings.slowBurnEnabled = true;
    const body = 'R'.repeat(1374) + 'X'.repeat(40);
    r.context.chat.push({ mes: body + `<sfw_scene>${JSON.stringify({ ...state, stage: 5, heat: 8 })}</sfw_scene>` });
    r.api.handleIncomingMessage(0);
    const own = r.rows().find(e => e.stage === 'body_write').data;
    assert.equal(own.ownWrite, true); assert.equal(own.sameSceneBody, true);
    assert.equal(r.report().current.currentStage, 5);
    assert.equal(r.report().current.stageSource, 'reported');
    vm.runInContext('SillyTavern.getContext().chat[0].mes = SillyTavern.getContext().chat[0].mes.slice(0, -40)', r.env,
        { filename: 'http://localhost:8000/scripts/extensions/third-party/test-cleaner/index.js?key=PRIVATE_KEY#PRIVATE_FRAGMENT' });
    const write = r.rows().filter(e => e.stage === 'body_write').at(-1).data;
    assert.equal(write.beforeChars, 1414); assert.equal(write.afterChars, 1374);
    assert.equal(write.removedChars, 40); assert.equal(write.removedLetters, 40);
    assert.equal(write.addedChars, 0); assert.equal(write.changeStart, 1374);
    assert.equal(write.ownWrite, false); assert.equal(write.writerLocated, true);
    assert.equal(write.writeTrace[0].script, '/scripts/extensions/third-party/test-cleaner/index.js');
    assert.equal(write.savedStage, 5); assert.equal(write.cached, false);
    r.api.handleIncomingMessage(0);
    assert.equal(r.report().current.currentStagePresent, false);
    assert.equal(r.report().current.latestBodyChanged, true);
    assert.equal(r.report().current.stageSource, 'unknown');
    assert.equal(r.report().current.displayedStage, null);
    assert.equal(r.settings.autoRefine, false); assert.equal(r.calls.length, 0);
    assert.ok(r.rows().some(e => e.stage === 'cache_invalidated' && e.data.savedStage === 5));
    const exported = r.api.diagnosticReport();
    for (const secret of ['PRIVATE_KEY', 'PRIVATE_FRAGMENT', 'PRIVATE_NAME', 'PRIVATE ROOM', 'RRRRR', 'XXXXX', 'http://localhost']) assert.ok(!exported.includes(secret), secret);
});
test('stage omission is distinct from a saved stage invalidated later', () => {
    const r = runtime(); r.settings.slowBurnEnabled = true;
    r.context.chat.push({ mes: 'Reply.' + stateTag }); r.api.handleIncomingMessage(0);
    const observed = r.rows().find(e => e.stage === 'response_observed').data;
    assert.equal(observed.reportedStagePresent, false); assert.ok(observed.missing.includes('stage'));
    assert.equal(r.report().current.currentStagePresent, false); assert.equal(r.report().current.stageSource, 'intensity');
    r.context.chatMetadata.ttottoSfw.slowBurnStageOverride = 3;
    assert.equal(r.report().current.displayedStage, 3); assert.equal(r.report().current.stageSource, 'manual');
});
for (const stop of ['disable', 'clear', 'chat-change']) test(`body tracing releases descriptors and keeps actual text on ${stop}`, () => {
    const r = runtime(), message = { mes: 'Before' }; r.context.chat.push(message);
    r.api.diagnosticTrackBody(message, 0, 'before_collection');
    assert.equal(typeof Object.getOwnPropertyDescriptor(message, 'mes').set, 'function');
    message.mes = 'After';
    assert.equal(JSON.stringify(message), '{"mes":"After"}'); assert.equal(structuredClone(message).mes, 'After');
    if (stop === 'disable') { r.settings.diagnosticsEnabled = false; r.api.syncDiagnosticFetch(); }
    else if (stop === 'clear') r.api.clearDiagnostics();
    else { r.context.chatMetadata = {}; r.context.chat = []; message.mes = 'New chat ignored'; }
    const descriptor = Object.getOwnPropertyDescriptor(message, 'mes');
    assert.equal(descriptor.get, undefined); assert.equal(descriptor.writable, true);
    assert.equal(descriptor.value, stop === 'chat-change' ? 'New chat ignored' : 'After');
    const count = r.rows().length; message.mes = 'Unwatched'; assert.equal(r.rows().length, count);
});
test('trace never wraps existing accessors or non-configurable fields or replaces a later foreign descriptor', () => {
    const r = runtime(), message = {}; let value = 'Private';
    const getter = () => value, setter = next => { value = next; };
    Object.defineProperty(message, 'mes', { configurable: true, get: getter, set: setter });
    r.context.chat.push(message); r.api.diagnosticTrackBody(message, 0, 'before_collection');
    assert.equal(Object.getOwnPropertyDescriptor(message, 'mes').get, getter);
    Object.defineProperty(message, 'mes', { configurable: true, value: 'Plain', writable: true });
    r.api.diagnosticTrackBody(message, 0, 'before_collection');
    Object.defineProperty(message, 'mes', { configurable: true, get: getter, set: setter });
    r.api.clearDiagnostics(); assert.equal(Object.getOwnPropertyDescriptor(message, 'mes').get, getter);
    Object.defineProperty(message, 'mes', { configurable: false });
    r.api.diagnosticTrackBody(message, 0, 'before_collection');
    assert.ok(r.rows().some(e => e.stage === 'body_write_trace_unavailable'));
});
test('trace is bounded and does not misattribute swipe changes, user messages or replaced message objects', () => {
    const r = runtime();
    for (let index = 0; index < 13; index++) {
        const message = { mes: 'Reply', swipe_id: 0 }; r.context.chat.push(message);
        r.api.diagnosticTrackBody(message, index, 'before_collection');
    }
    assert.equal(Object.getOwnPropertyDescriptor(r.context.chat[0], 'mes').get, undefined);
    const message = r.context.chat[12];
    message.mes = message.mes; assert.ok(!r.rows().some(e => e.stage === 'body_write'));
    message.swipe_id = 1; message.mes = 'Different swipe';
    assert.ok(!r.rows().some(e => e.stage === 'body_write'));
    assert.ok(r.rows().some(e => e.data.reason === 'swipe_changed'));
    r.api.diagnosticTrackBody(message, 12, 'message_swiped');
    message.mes = 'Edited swipe';
    assert.equal(r.rows().filter(e => e.stage === 'body_write').at(-1).data.swipe, 1);
    r.context.chat[12] = { mes: 'Replacement' };
    const count = r.rows().length; message.mes = 'Old detached object'; assert.equal(r.rows().length, count);
    r.context.chat[11].is_user = true; r.context.chat[11].mes = 'User text'; assert.equal(r.rows().length, count);
});
test('large or non-string assignments still succeed without retaining diagnostic text', () => {
    const r = runtime(), message = { mes: 'Original' }; r.context.chat.push(message);
    r.api.diagnosticTrackBody(message, 0, 'before_collection');
    message.mes = 'x'.repeat(65537);
    assert.equal(message.mes.length, 65537); assert.equal(Object.getOwnPropertyDescriptor(message, 'mes').get, undefined);
    message.mes = 'Again'; r.api.diagnosticTrackBody(message, 0, 'before_collection');
    message.mes = null; assert.equal(message.mes, null);
    assert.ok(r.rows().some(e => e.data.reason === 'size_or_type_limit'));
});
test('stack sanitization handles Chrome and Firefox and preserves unknown direct callers', () => {
    const r = runtime();
    const own = 'http://localhost:8000/scripts/extensions/third-party/ttottosfw/index.js:1:2';
    for (const stack of [`Error\n at set (${own})\n at PRIVATE_FUNCTION (http://localhost:8000/script.js?token=PRIVATE_KEY:30:4)`,
        `set@${own}\nPRIVATE_FUNCTION@http://localhost:8000/script.js?token=PRIVATE_KEY:30:4`]) {
        const frames = r.api.diagnosticWriteTrace(stack);
        assert.equal(frames[0].script, '/script.js'); assert.equal(frames[0].line, 30); assert.equal(frames[0].column, 4);
        assert.ok(!JSON.stringify(frames).includes('PRIVATE'));
    }
    for (const unknown of ['at /home/PRIVATE_NAME/index.js:1:2', 'at http://foreign.example/scripts/index.js:1:2', 'at http://localhost:8000/private/PRIVATE_KEY.js:1:2', 'at eval (<anonymous>:1:2)']) {
        const frames = r.api.diagnosticWriteTrace(`Error\n at set (${own})\n ${unknown}\n at http://localhost:8000/script.js:5:6`);
        assert.equal(frames[0].source, 'unknown'); assert.equal(frames[1].script, '/script.js');
        assert.ok(!JSON.stringify(frames).includes('PRIVATE'));
    }
});
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
    for (let i = 0; i < 450; i++) r.api.diagnosticRecord('test', { message: i });
    assert.equal(r.rows().length, 400);
    r.api.diagnosticRecord('test', { message: 449 }); assert.equal(r.rows().at(-1).repeats, 2);
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

const reportInfo = { reportInstruction: true, stream: false };
const responseOf = obj => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
const chatResponse = text => responseOf({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

test('server tag retained in diagnostics even when the message arrives without it', async () => {
    const r = runtime();
    await r.api.diagnosticInspectResponse(chatResponse('PRIVATE BODY\n' + stateTag), reportInfo, 7, 1, 0);
    r.context.chat.push({ mes: 'PRIVATE BODY' }); r.api.handleIncomingMessage(0);
    const server = r.rows().find(e => e.stage === 'server_response_observed').data;
    assert.equal(server.parsed, true); assert.equal(server.complete, true);
    const link = r.rows().find(e => e.stage === 'response_message_link').data;
    assert.equal(link.reason, 'exact_body_match'); assert.equal(link.requestId, 7); assert.equal(link.serverTag, true);
    assert.ok(r.rows().some(e => e.stage === 'collection_result' && !e.data.saved));
    for (const secret of ['PRIVATE BODY', 'PRIVATE_NAME', 'PRIVATE ROOM']) assert.ok(!r.api.diagnosticReport().includes(secret));
});
test('completed server response with no tag is distinguished from an unreadable response', async () => {
    const r = runtime();
    await r.api.diagnosticInspectResponse(chatResponse('Plain reply'), reportInfo, 1, 1, 0);
    await r.api.diagnosticInspectResponse(responseOf({ unknown: 'PRIVATE_KEY' }), reportInfo, 2, 1, 0);
    const rows = r.rows();
    assert.ok(rows.some(e => e.stage === 'server_response_observed' && e.data.reason === 'missing_tag' && e.data.complete));
    assert.ok(rows.some(e => e.stage === 'server_response_unavailable' && e.data.reason === 'unsupported_response'));
    assert.ok(!r.api.diagnosticReport().includes('PRIVATE_KEY'));
});
test('fetch clone is taken before caller consumption and the original promise and response remain intact', async () => {
    const response = chatResponse('PRIVATE BODY\n' + stateTag);
    const r = runtime(true, response); r.api.syncDiagnosticFetch(); r.api.prepareSceneInjection({ generationType: 'normal' });
    const p = r.env.fetch('/api/backends/chat-completions/generate', { body: JSON.stringify({ messages: [{ content: r.prompts.ttotto_sfw_continuity }] }) });
    assert.equal(p, r.promise); assert.equal(await p, response);
    assert.ok((await response.text()).includes(stateTag.replaceAll('"', '\\"')));
    for (let i = 0; i < 30 && !r.rows().some(e => e.stage === 'server_response_observed'); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(r.rows().some(e => e.stage === 'server_response_observed' && e.data.parsed), r.api.diagnosticReport());
});
test('split SSE chunks reconstruct tags and exclude reasoning content', async () => {
    const text = 'PRIVATE BODY\n' + stateTag;
    const frames = [...text].map(c => 'data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n').join('')
        + 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING' }, finish_reason: 'stop' }] }) + '\n\n'
        + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(frames);
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17)); controller.close(); } });
    const r = runtime();
    await r.api.diagnosticInspectResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { ...reportInfo, stream: true }, 1, 1, 0);
    const data = r.rows().find(e => e.stage === 'server_response_observed').data;
    assert.equal(data.complete, true); assert.equal(data.parsed, true); assert.equal(data.chars, text.length);
    assert.ok(!r.api.diagnosticReport().includes('PRIVATE_REASONING'));
});
test('interrupted stream is never reported as a complete tag omission', async () => {
    const r = runtime();
    await r.api.diagnosticInspectResponse(new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }), { ...reportInfo, stream: true }, 1, 1, 0);
    const data = r.rows().find(e => e.stage === 'server_response_observed').data;
    assert.equal(data.complete, false); assert.equal(data.reason, 'incomplete_stream');
});
test('Gemini and Anthropic response content is inspected without treating thinking as answer text', async () => {
    const r = runtime();
    await r.api.diagnosticInspectResponse(responseOf({ candidates: [{ content: { parts: [{ thought: true, text: 'PRIVATE_REASONING' }, { text: stateTag }] }, finishReason: 'MAX_TOKENS' }] }), reportInfo, 1, 1, 0);
    await r.api.diagnosticInspectResponse(responseOf({ content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: stateTag }], stop_reason: 'end_turn' }), reportInfo, 2, 1, 0);
    const rows = r.rows().filter(e => e.stage === 'server_response_observed');
    assert.equal(rows.length, 2); assert.ok(rows.every(e => e.data.parsed && e.data.chars === stateTag.length));
    assert.equal(rows[0].data.tokenLimited, true); assert.equal(rows[1].data.stopped, true);
});
test('rewritten and duplicate candidates never get an assumed unique response association', async () => {
    const r = runtime();
    await r.api.diagnosticInspectResponse(chatResponse('old candidate'), reportInfo, 1, 1, 0);
    await r.api.diagnosticInspectResponse(chatResponse('accepted candidate'), reportInfo, 2, 1, 0);
    r.api.diagnosticTrackBody({ mes: 'accepted candidate' }, 2, 'message_received');
    assert.equal(r.rows().filter(e => e.stage === 'response_message_link').at(-1).data.requestId, 2);
    await r.api.diagnosticInspectResponse(chatResponse('accepted candidate'), reportInfo, 3, 1, 0);
    r.api.diagnosticTrackBody({ mes: 'accepted candidate' }, 3, 'message_received');
    const ambiguous = r.rows().filter(e => e.stage === 'response_message_link').at(-1).data;
    assert.equal(ambiguous.reason, 'ambiguous_body_match'); assert.equal(ambiguous.requestId, undefined);
    r.api.diagnosticTrackBody({ mes: 'different translated output' }, 4, 'message_received');
    assert.equal(r.rows().filter(e => e.stage === 'response_message_link').at(-1).data.reason, 'no_exact_body_match');
});
test('body change records separate own tag removal, markup cleanup and actual text changes', () => {
    const r = runtime(), message = { mes: 'PRIVATE BODY\n' + stateTag };
    r.context.chat.push(message); r.api.handleIncomingMessage(0);
    assert.ok(r.rows().some(e => e.stage === 'body_changed' && e.data.reason === 'after_collection' && e.data.sameSceneBody));
    message.mes = '**PRIVATE BODY**'; r.api.handleIncomingMessage(0);
    const markup = r.rows().filter(e => e.stage === 'body_changed').at(-1).data;
    assert.equal(markup.markupOnly, true); assert.equal(markup.sameSceneBody, false);
    message.mes = 'DIFFERENT CONTENT'; r.api.handleIncomingMessage(0);
    assert.equal(r.rows().filter(e => e.stage === 'body_changed').at(-1).data.markupOnly, false);
    assert.ok(!r.api.diagnosticReport().includes('PRIVATE BODY'));
});
test('oversized and malformed response copies are explicitly unconfirmed', async () => {
    const r = runtime();
    await r.api.diagnosticInspectResponse(new Response('x'.repeat(1024 * 1024 + 1)), reportInfo, 1, 1, 0);
    await r.api.diagnosticInspectResponse(new Response('not JSON'), reportInfo, 2, 1, 0);
    assert.ok(r.rows().some(e => e.data.reason === 'size_limit'));
    assert.ok(r.rows().some(e => e.data.reason === 'invalid_json'));
    assert.ok(!r.rows().some(e => e.stage === 'server_response_observed'));
});
test('clearing diagnostics during a response read cancels observation and discards transient evidence', async () => {
    const r = runtime();
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const pending = r.api.diagnosticInspectResponse(new Response(stream), reportInfo, 1, 1, 0);
    r.api.clearDiagnostics(); await pending;
    assert.equal(cancelled, true); assert.equal(r.rows().length, 0);
});

test('diagnostics count object state and NSFW heat without exporting names or state text', async () => {
    const r = runtime();
    const tag = '<sfw_scene>' + JSON.stringify({ ...state, important_objects: { PRIVATE_OBJECT: 'PRIVATE_OBJECT_STATE' } }) + '</sfw_scene>';
    await r.api.diagnosticInspectResponse(chatResponse('PRIVATE BODY' + '<scene_state>{"heat":6}</scene_state>' + tag), reportInfo, 1, 1, 0);
    const data = r.rows().find(e => e.stage === 'server_response_observed').data;
    assert.equal(data.characters, 1); assert.equal(data.objects, 1); assert.equal(data.nsfwHeat, 6);
    r.context.chat.push({ mes: 'PRIVATE BODY' + tag }); r.api.handleIncomingMessage(0);
    assert.equal(r.rows().find(e => e.stage === 'collection_result').data.savedObjects, 1);
    for (const text of ['PRIVATE_OBJECT', 'PRIVATE_OBJECT_STATE', 'PRIVATE BODY']) assert.ok(!r.api.diagnosticReport().includes(text));
});
test('conditional return-report requests are recognized at the fetch boundary', async () => {
    const r = runtime(); r.context.extensionSettings['ttotto-nsfw'] = { enabled: true };
    r.env.ttottoNsfwSceneBridge = { sync: () => true };
    r.api.syncDiagnosticFetch(); r.api.prepareSceneInjection({ generationType: 'normal' });
    await r.env.fetch('/api/backends/chat-completions/generate', { body: JSON.stringify({ messages: [{ content: r.prompts.ttotto_sfw_continuity }] }) });
    const row = r.rows().find(e => e.stage === 'request_observed').data;
    assert.equal(row.returnReport, true); assert.equal(row.reportInstruction, true);
    assert.equal(row.sfwDirective, false);
});

test('inherited assignments and same-metadata chat ID switches retain native semantics', () => {
    const r = runtime(), message = { mes: 'Parent' }; r.context.chat.push(message); r.context.chatId = 'first';
    r.api.diagnosticTrackBody(message, 0, 'before_collection');
    const child = Object.create(message); child.mes = 'Child';
    assert.equal(message.mes, 'Parent'); assert.equal(child.mes, 'Child');
    assert.equal(Object.getOwnPropertyDescriptor(child, 'mes').writable, true);
    assert.ok(!r.rows().some(e => e.stage === 'body_write'));
    r.context.chatId = 'second'; message.mes = 'Different chat';
    assert.equal(Object.getOwnPropertyDescriptor(message, 'mes').get, undefined);
    assert.ok(!r.rows().some(e => e.stage === 'body_write'));
});
