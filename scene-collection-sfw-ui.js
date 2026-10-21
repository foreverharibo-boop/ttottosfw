// Global SFW description settings, independent of custom prompt scopes.
function renderSceneCollectionUi() {
    const settings = getSettings(), config = settings.sceneCollection ?? {};
    const master = element('tsf-scene-collection-enabled');
    if (!master) return;
    const language = element('tsf-scene-record-language');
    if (language) language.value = config.language === 'en' ? 'en' : 'ko';
    master.checked = config.enabled !== false;
    for (const key of Object.keys(sceneCollectionFields())) {
        const input = element(`tsf-scene-collect-${key}`);
        if (!input) continue;
        input.checked = config.fields?.[key] !== false;
        input.disabled = !master.checked;
    }
}
function bindSceneCollectionUi() {
    element('tsf-scene-record-language')?.addEventListener('change', event => {
        const value = event.target.value;
        if (!['ko', 'en'].includes(value)) return;
        (getSettings().sceneCollection ??= {}).language = value;
        getContext().saveSettingsDebounced?.();
        clearInjectedPrompt();
        updateUi();
    });
    for (const key of ['enabled', ...Object.keys(sceneCollectionFields())]) {
        const input = element(key === 'enabled' ? 'tsf-scene-collection-enabled' : `tsf-scene-collect-${key}`);
        input?.addEventListener('change', () => {
            const settings = getSettings();
            const config = settings.sceneCollection ??= {};
            if (key === 'enabled') config.enabled = input.checked;
            else (config.fields ??= {})[key] = input.checked;
            getContext().saveSettingsDebounced?.();
            clearInjectedPrompt();
            updateUi();
        });
    }
}
