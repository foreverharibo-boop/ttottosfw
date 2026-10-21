// Scene descriptions are optional; control/history fields are never masked.
export function sceneCollectionFields(settings = {}) {
    const config = settings.sceneCollection ?? {};
    return Object.fromEntries(['location', 'time', 'environment', 'objects', 'appearance', 'position', 'holding', 'condition', 'contact']
        .map(key => [key, config.enabled !== false && config.fields?.[key] !== false]));
}

export function filterSceneCollection(raw, settings = {}) {
    if (!raw || typeof raw !== 'object') return raw;
    const fields = sceneCollectionFields(settings);
    if (Object.values(fields).every(Boolean)) return raw;
    const out = structuredClone(raw);
    const filter = scene => {
        if (!scene || typeof scene !== 'object') return;
        for (const [field, keys] of Object.entries({ location: ['location'], time: ['time'], environment: ['environment'], objects: ['important_objects', 'importantObjects'] })) {
            if (!fields[field]) for (const key of keys) delete scene[key];
        }
        if (scene.characters && typeof scene.characters === 'object') {
            for (const [name, person] of Object.entries(scene.characters)) {
                if (!person || typeof person !== 'object') continue;
                for (const [field, keys] of Object.entries({ appearance: ['appearance', 'clothing'], position: ['position'], holding: ['holding'], condition: ['condition'], contact: ['contact'] })) {
                    if (!fields[field]) for (const key of keys) delete person[key];
                }
                if (!Object.keys(person).length) delete scene.characters[name];
            }
        }
    };
    filter(out); filter(out.scene);
    return out;
}

// One wire record; the existing stores/UI remain backward compatible.
// Machine keys stay stable. Only descriptive values are Korean, not the RP prose.
export function expandCompactReport(raw, kind) {
    if (raw?._v !== 2) return raw;
    const scene = raw.scene;
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return null;
    if (kind === 'sfw') return scene;
    const characters = Object.fromEntries(Object.entries(scene.characters ?? {}).filter(([, v]) => v && typeof v === 'object').map(([name, info]) => [name, {
        clothing: info.appearance, position: info.position, contact: info.contact,
    }]));
    return { location: scene.location, characters, acts: scene.acts,
        dialogue_beats: scene.dialogue_beats, next: scene.next, heat: raw.heat, stage: raw.stage, scene };
}

export function readCompactReport(text, parse = JSON.parse) {
    const matches = [...String(text ?? '').matchAll(/<(sfw_scene|scene_state)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    // Never revive an earlier report behind a malformed newer compact report.
    for (let i = matches.length - 1; i >= 0; i--) {
        try {
            const raw = parse(matches[i][2].trim());
            if (raw?._v === 2) return raw;
        } catch { return null; }
    }
    return null;
}

export function compactReportLines(kind, options, { repair = false, heatRules = [], stageRules = [], nextGuidance = '' } = {}) {
    const sfw = options.sfw ?? {}, nsfw = options.nsfw ?? {};
    const active = kind === 'nsfw' ? nsfw : sfw;
    const heat = kind === 'nsfw' || options.monitor;
    const contact = heat; // Preserve contact when a general reply transitions into intimacy.
    const person = { appearance: '', position: '', holding: '', condition: '', ...(contact ? { contact: '' } : {}) };
    const scene = { location: '', time: '', environment: '', important_objects: {}, characters: { name: person }, scene_type: 'general', intensity: 0 };
    if ((kind === 'sfw' || options.sfwEnabled) && sfw.slowBurnEnabled) scene.stage = 1;
    if (kind === 'nsfw' || active.repeatGuard || (options.sfwEnabled && sfw.repeatGuard)) scene.acts = [];
    if (active.dialogueBeatGuard || (options.sfwEnabled && sfw.dialogueBeatGuard)) scene.dialogue_beats = [];
    if (sfw.dialogueFlow) scene.dialogue_flow = { topic: '', last_question: '', new_facts: [] };
    if (active.nextBeatHints || (options.sfwEnabled && sfw.nextBeatHints)) scene.next = [];
    const selected = filterSceneCollection(scene, active);
    if (selected.characters && !Object.keys(selected.characters).length) delete selected.characters;
    const record = { _v: 2, scene: selected, ...(heat ? { heat: 0 } : {}) };
    if (kind === 'nsfw' && nsfw.slowBurnEnabled) record.stage = 1;
    const tag = kind === 'nsfw' ? 'scene_state' : 'sfw_scene';
    return [
        repair ? 'Read the RP log and return ONLY one JSON object matching this schema:'
            : 'STATE REPORT: End your response with exactly one state block (single-line JSON, hidden from the reader). No other scene report:',
        repair ? JSON.stringify(record) : `<${tag}>${JSON.stringify(record)}</${tag}>`,
        'Write descriptive values concisely in Korean only; keep JSON keys, enum values and character names unchanged. Do not add English translations. This language rule applies ONLY to the record, not the story.',
        'Record facts at the END of the reply using ONLY the fields in this schema. Omit disabled fields entirely; do not relocate their descriptions into other fields. For selected fields, include unchanged facts and every relevant character/object. Unknown values stay empty; never invent facts or write unchanged/no_change acknowledgements. Escape quotes and line breaks. Bookkeeping must not change the story.',
        ...('time' in selected ? ['Use RP time only, never the real date/clock. Preserve explicit in-story date/time (including Info_panel); otherwise keep established time context without inventing a clock time.'] : []),
        'scene_type: general/daily/conversation/romance/conflict/action/investigation; keep it unless the dominant scene changes. intensity: narrative tension 0-10, not sexual heat.',
        ...(scene.stage !== undefined ? ['scene.stage: observed narrative progression 1 setup, 2 engagement, 3 first development, 4 deepening, 5 decisive turn, 6 resolution; not sexual stage or permission to finish.'] : []),
        ...(scene.acts ? ['acts: up to 4 substantive NEW beats from this reply, not routine logistics.'] : []),
        ...(scene.dialogue_beats ? ['dialogue_beats: up to 3 conversational intents, not quotations; [] if no dialogue.'] : []),
        ...(scene.dialogue_flow ? ['dialogue_flow: current topic, latest unanswered CHARACTER question (empty if answered/superseded), up to 3 newly established facts; no unrelated unresolved plots.'] : []),
        ...(scene.next ? ['next: 2-3 plausible future beats, not facts or repetitions of acts/new_facts; obey the current scene, user intent, bans and active pacing.'] : []),
        ...(heat ? heatRules : []),
        ...(record.stage !== undefined ? stageRules : []),
        ...(nextGuidance ? [nextGuidance] : []),
        'Example numbers are placeholders. Report actual observations, never copy the examples or repeat common facts outside scene.',
    ];
}
