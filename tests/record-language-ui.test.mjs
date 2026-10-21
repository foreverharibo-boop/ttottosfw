import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
for (const kind of ['sfw', 'nsfw']) {
    const prefix = kind === 'sfw' ? 'tsf' : 'tns';
    const file = kind === 'sfw' ? 'scene-collection-sfw-ui.js' : 'scene-collection-ui.js';
    if (!fs.existsSync(new URL(file, root))) continue;
    test(kind + ': record language persists separately from master/field choices and survives reopening', () => {
        const settings = { sceneCollection: { enabled: false, fields: { time: false } } }, nodes = new Map();
        let saves = 0, clears = 0;
        const element = id => { if (!nodes.has(id)) nodes.set(id, { value: '', addEventListener(_, fn) { this.change = fn; } }); return nodes.get(id); };
        const box = { getSettings: () => settings, element, sceneCollectionFields: () => ({ time: true }),
            getContext: () => ({ saveSettingsDebounced() { saves++; } }), clearInjectedPrompt() { clears++; },
            updateUi() { box.renderSceneCollectionUi(); } };
        vm.createContext(box); vm.runInContext(fs.readFileSync(new URL(file, root), 'utf8'), box);
        box.renderSceneCollectionUi(); box.bindSceneCollectionUi();
        const language = element(prefix + '-scene-record-language');
        assert.equal(language.value, 'ko');
        for (const value of ['en', 'ko', 'en']) {
            language.value = value; language.change({ target: language }); box.renderSceneCollectionUi();
            assert.equal(language.value, value); assert.equal(settings.sceneCollection.language, value);
            assert.equal(settings.sceneCollection.enabled, false); assert.equal(settings.sceneCollection.fields.time, false);
        }
        assert.equal(saves, 3); assert.equal(clears, 3);
        const saved = JSON.parse(JSON.stringify(settings)); Object.assign(settings, saved); box.renderSceneCollectionUi();
        assert.equal(language.value, 'en');
        language.value = 'invalid'; language.change({ target: language }); assert.equal(saves, 3);
        const htmlFile = fs.existsSync(new URL(`modes/${kind}/settings.html`, root)) ? `modes/${kind}/settings.html` : 'settings.html';
        const html = fs.readFileSync(new URL(htmlFile, root), 'utf8');
        assert.ok(html.includes(`id="${prefix}-scene-record-language"`));
    });
}
