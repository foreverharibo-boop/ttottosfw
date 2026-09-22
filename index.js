// 🫧또또sfw — 장면 연속성 추적 + 직전 전개 반복 금지 + 진도 강제 (SFW 버전)
// 또또(ttotto)의 자매 확장. 정적 import 없이 getContext() 기반으로 동작.
//
// 동작 개요 (하이브리드):
//  1) 매 생성마다 프롬프트에 "현재 장면 상태 + 최근 N턴 전개(반복 금지) + 상태 태그 갱신 지시"를 주입
//  2) AI 응답 끝의 <scene_state>{...}</scene_state> 태그를 파싱해 메시지 extra에 저장하고 본문에서 제거
//  3) 태그가 누락되면(또는 수동 버튼) 보조 AI 호출로 최근 대화를 분석해 상태를 보정

const MODULE_NAME = 'ttotto-sfw';
const EXTENSION_BASE_URL = new URL('.', import.meta.url);
const PROMPT_KEY = 'ttotto_sfw_continuity';
const CHAT_STATE_KEY = 'ttottoSfw';
const MESSAGE_EXTRA_KEY = 'ttottoSfw';
const LOG_PREFIX = '[🫧또또sfw]';
const EXTENSION_VERSION = '0.13.1-sfw';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const DEVELOPER_UNLOCK_TAPS = 7;
const DEVELOPER_TAP_RESET_MS = 5000;
const DEVELOPER_PASSWORD = '130918';
const PROMPT_POSITION_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;

const STATE_TAG_REGEX = /<scene_state\b[^>]*>([\s\S]*?)<\/scene_state>/gi;
const STATE_TAG_LOOSE_REGEX = /```(?:json)?\s*<scene_state\b[^>]*>[\s\S]*?<\/scene_state>\s*```/gi;
const STATE_TRAILING_ACK_REGEX = /(<\/scene_state>[ \t]*(?:\r?\n[ \t]*```)?)[ \t\r\n]+(?:no\s+changes?|unchanged)[ \t]*[.!]?[ \t]*$/i;

const PACE_INSTRUCTIONS = Object.freeze({
    hold: 'Maintain the current mood and tone of the scene. Deepen character emotion and interaction without rushing forward.',
    slow: 'Move the scene forward to its next natural beat. Advance gradually — one meaningful step per response.',
    push: 'Actively develop the scene. Each response must clearly progress beyond where the previous one ended.',
});

// 스토리 단계 — 서사적 진행도를 추적한다.
const STORY_STAGES = Object.freeze([
    null,
    { en: 'Scene setting and atmosphere', ko: '장면 설정과 분위기 형성' },
    { en: 'Character introduction and interaction', ko: '인물 소개와 첫 교류' },
    { en: 'Rising tension or conflict', ko: '긴장감 또는 갈등 고조' },
    { en: 'Climax or confrontation', ko: '클라이맥스 또는 대결' },
    { en: 'Resolution begins', ko: '해결 시작' },
    { en: 'Conclusion or aftermath', ko: '결말 또는 여운' },
]);

const SLOW_BURN_MIN_TURNS = Object.freeze({
    gentle: 1,
    slow: 2,
    verySlow: 3,
});
const SLOW_BURN_TARGET_MAX_TURNS = 20;
const SLOW_BURN_TARGET_MAX_LENGTH = 200;
const DIALOGUE_BEAT_WINDOW = 2;

// 장면 스타일 다이얼
const STYLE_LENGTH_INSTRUCTIONS = Object.freeze({
    tight: 'Length: keep the response tight — 2-3 short paragraphs. Every sentence must carry emotion, action, or reaction; cut filler narration. Leave room for the user to act.',
    normal: '',
    long: 'Length: write a full, unhurried response — take space to build each moment. Do not rush through beats; linger where it matters.',
});
const STYLE_BALANCE_INSTRUCTIONS = Object.freeze({
    dialogue: 'Balance: dialogue-forward. The character keeps talking through the scene — reacting, questioning, sharing, wondering. Description supports the dialogue, not the other way around.',
    balanced: '',
    sensory: 'Balance: sensory-forward. Prioritize concrete physical details — environment, expressions, sounds, atmosphere. Keep dialogue sparse and purposeful.',
    internal: 'Balance: interiority-forward. Keep the character\'s inner voice present — thoughts, hesitation, want, conflict — woven through the action.',
});

// 해제 브릿지
const BRIDGE_LINES = [
    '[Scene Wind-Down] The scene has just concluded. This response is the wind-down: settle the atmosphere naturally — quiet moments, small gestures, reflective words, gentle closure.',
    'Reflect what just happened in the characters\' mood and connection. Do not restart or escalate the scene, and do not jump abruptly to unrelated narration.',
];

const SAFETY_LIMIT = 1000000;

// 자동 무장 히스테리시스: 장면 강도 기준
const AUTO_ARM_ON = 4;
const AUTO_ARM_OFF = 1;

// 스텔스 모드: 최근 메시지에서 장면 전환 신호를 점수화
const STEALTH_WINDOW = 4;
const STEALTH_THRESHOLDS = Object.freeze({ high: 3, normal: 5, low: 8 });
const STEALTH_COLD_STREAK = 3;
const REFINE_MESSAGE_CHAR_LIMIT = 12000;
const REFINE_TOTAL_CHAR_LIMIT = 60000;

// 장면 강도 척도 (SFW)
const INTENSITY_SCALE_LINES = Object.freeze([
    'INTENSITY SCALE (judge the scene facts at the END of the response):',
    '- 0-1: calm/neutral; 2: mild emotional charge or gentle interaction.',
    '- 3-4: notable tension, conflict, or strong emotional engagement.',
    '- 5-6: confrontation, high drama, or pivotal story moment.',
    '- 7-8: climax-level intensity or major revelation; 9: resolution approaching; 10: scene conclusion or major turning point.',
]);

// SFW 스텔스 감지 어휘 — 장면 강도·감정 신호 기반
const STEALTH_LEXICON = [
    // 강한 신호 (3점): 대결·갈등·위기
    { label: '갈등·위기', re: /싸움|다툼|충돌|대결|위기|비명|울음|눈물|분노|절망|배신|폭로|충격|revelation|confrontation|crisis|conflict|shout|scream|cry|tears|despair|betrayal|shock/gi, w: 3 },
    // 중간 신호 (2점): 감정 고조·긴장
    { label: '감정·긴장', re: /긴장|두근|설레|불안|떨림|걱정|초조|흥분|격렬|dramatic|tense|nervous|anxious|excited|trembl|heart\s*pound|uneasy|fierce/gi, w: 2 },
    // 약한 신호 (1점): 장면 전환·분위기
    { label: '분위기', re: /분위기|침묵|정적|숨막히|눈빛|마주치|atmosphere|silence|stillness|gaze|met\s+(?:his|her|their)\s+eyes|breath\s+held/gi, w: 1 },
];

const DEFAULT_SETTINGS = Object.freeze({
    settingsSchemaVersion: 2,
    enabled: true,
    dialogueBeatGuard: true,
    dialogueWindow: 2,
    cardLinkEnabled: false,
    cardLinkSelected: {},
    armMode: 'stealth',
    stealthSensitivity: 'normal',
    stealthKeywords: '',
    nextBeatHints: true,
    repeatWindow: 3,
    maxBannedActs: 15,
    paceMode: 'auto',
    slowBurnEnabled: false,
    slowBurnIntensity: 'slow',
    slowBurnUserOverride: true,
    globalBans: [],
    styleLength: 'normal',
    styleBalance: 'balanced',
    exitBridge: true,
    autoRefine: true,
    refineProfileId: '',
    refineMaxTokens: 3000,
    refineContextMessages: 8,
});

let runtimeActive = true;
let uiReady = false;
let eventsRegistered = false;
let refineRunning = false;
let refineAbortController = null;
let refineTimer = null;
let popupOpen = false;
let settingsHomeParent = null;
let developerTapCount = 0;
let developerTapTimer = null;
const registeredEventHandlers = [];

// ───────────────────────── 컨텍스트/설정 ─────────────────────────

function getContext() {
    return SillyTavern.getContext();
}

function getEventTypes(context = getContext()) {
    return context.eventTypes ?? context.event_types ?? {};
}

function getSettings() {
    const context = getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = context.extensionSettings[MODULE_NAME];
    const previousSchemaVersion = Number(settings.settingsSchemaVersion) || 0;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    if (previousSchemaVersion < 2 && settings.paceMode === 'slow') settings.paceMode = 'auto';
    settings.settingsSchemaVersion = 2;
    const refineTokens = Number(settings.refineMaxTokens);
    settings.refineMaxTokens = Number.isFinite(refineTokens)
        ? Math.min(4000, Math.max(1000, Math.round(refineTokens)))
        : DEFAULT_SETTINGS.refineMaxTokens;
    if (!Object.prototype.hasOwnProperty.call(SLOW_BURN_MIN_TURNS, settings.slowBurnIntensity)) settings.slowBurnIntensity = 'slow';
    const dialogueWindow = Number(settings.dialogueWindow);
    settings.dialogueWindow = Number.isFinite(dialogueWindow)
        ? Math.min(6, Math.max(1, Math.round(dialogueWindow)))
        : DIALOGUE_BEAT_WINDOW;
    if (!settings.cardLinkSelected || typeof settings.cardLinkSelected !== 'object' || Array.isArray(settings.cardLinkSelected)) {
        settings.cardLinkSelected = {};
    }
    if (previousSchemaVersion < 2 || settings.refineMaxTokens !== refineTokens) {
        context.saveSettingsDebounced?.();
    }
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function setDeveloperMode(enabled) {
    const settings = getSettings();
    settings.developerMode = Boolean(enabled);
    if (!settings.developerMode) {
        const meta = getChatMeta(false);
        if (meta) {
            meta.slowBurnTargetActive = false;
            meta.slowBurnTargetCompleted = false;
            meta.slowBurnRecoveryPending = false;
            saveChatMeta();
        }
    }
    saveSettings();
    updateUi();
    toastr.success(
        settings.developerMode ? '개발자 모드를 활성화했어요.' : '개발자 모드를 해제했어요.',
        '🫧또또sfw',
    );
}

function handleDeveloperTitleTap(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    developerTapCount += 1;
    clearTimeout(developerTapTimer);
    developerTapTimer = setTimeout(() => {
        developerTapCount = 0;
        developerTapTimer = null;
    }, DEVELOPER_TAP_RESET_MS);
    if (developerTapCount < DEVELOPER_UNLOCK_TAPS) return;
    developerTapCount = 0;
    clearTimeout(developerTapTimer);
    developerTapTimer = null;
    const entered = window.prompt('개발자 모드 비밀번호를 입력하세요.');
    if (entered === null) return;
    if (entered.trim() !== DEVELOPER_PASSWORD) {
        toastr.error('비밀번호가 올바르지 않아요.', '🫧또또sfw');
        return;
    }
    setDeveloperMode(!getSettings().developerMode);
}

function getChatMeta(create = true) {
    const context = getContext();
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') return null;
    if (!context.chatMetadata[CHAT_STATE_KEY]) {
        if (!create) return null;
        context.chatMetadata[CHAT_STATE_KEY] = {
            enabled: false,
            manualState: null,
            ignoredActs: [],
            autoArmed: false,
            slowBurnStageOverride: null,
            slowBurnLocked: false,
            slowBurnSessionActive: false,
            slowBurnSessionStartAssistantCount: null,
            slowBurnRecoveryPending: false,
            slowBurnTarget: '',
            slowBurnTargetTurns: 3,
            slowBurnTargetActive: false,
            slowBurnTargetCompleted: false,
            ignoredDialogueBeats: [],
        };
    }
    const meta = context.chatMetadata[CHAT_STATE_KEY];
    if (!Array.isArray(meta.ignoredActs)) meta.ignoredActs = [];
    if (!Array.isArray(meta.ignoredDialogueBeats)) meta.ignoredDialogueBeats = [];
    if (!Array.isArray(meta.customBans)) meta.customBans = [];
    if (typeof meta.slowBurnTarget !== 'string') meta.slowBurnTarget = '';
    meta.slowBurnTarget = sanitizeSlowBurnTarget(meta.slowBurnTarget);
    meta.slowBurnTargetTurns = clampSlowBurnTargetTurns(meta.slowBurnTargetTurns);
    meta.slowBurnTargetActive = Boolean(meta.slowBurnTargetActive && meta.slowBurnTarget);
    meta.slowBurnTargetCompleted = Boolean(meta.slowBurnTargetCompleted && meta.slowBurnTarget);
    return meta;
}

function saveChatMeta() {
    const context = getContext();
    if (typeof context.saveMetadataDebounced === 'function') context.saveMetadataDebounced();
    else if (typeof context.saveMetadata === 'function') void context.saveMetadata();
}

// SFW: adultConfirmed 조건 없이 enabled + chatMeta.enabled 만으로 감시
function isSupervising() {
    const settings = getSettings();
    const meta = getChatMeta(false);
    return Boolean(runtimeActive && settings.enabled && meta?.enabled);
}

function isFullyArmed() {
    if (!isSupervising()) return false;
    const settings = getSettings();
    if (settings.armMode === 'manual') return true;
    return Boolean(getChatMeta(false)?.autoArmed);
}

// ───────────────────────── 스텔스 로컬 감지 ─────────────────────────

function nsfwScoreDetail(text) {
    const source = String(text ?? '');
    const hits = [];
    let score = 0;
    if (!source) return { score, hits };
    for (const { label, re, w } of STEALTH_LEXICON) {
        re.lastIndex = 0;
        let match;
        let count = 0;
        while (count < 3 && (match = re.exec(source)) !== null) {
            hits.push({ label, text: match[0], w });
            count++;
        }
        score += count * w;
    }
    const custom = String(getSettings().stealthKeywords ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    for (const keyword of custom) {
        if (source.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) {
            score += 3;
            hits.push({ label: '커스텀', text: keyword, w: 3 });
        }
    }
    return { score, hits };
}

function nsfwScore(text) {
    return nsfwScoreDetail(text).score;
}

function stealthWindowDetail() {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const from = Number(getChatMeta(false)?.stealthCooldownFrom ?? 0);
    const recent = chat
        .map((message, index) => ({ message, index }))
        .filter(({ message, index }) => message && !message.is_system && index >= from)
        .slice(-STEALTH_WINDOW);
    const hits = [];
    let score = 0;
    for (const { message } of recent) {
        const detail = nsfwScoreDetail(stripStateTag(message.mes));
        score += detail.score;
        hits.push(...detail.hits);
    }
    return { score, hits };
}

function stealthWindowScore() {
    return stealthWindowDetail().score;
}

function stealthColdStreak(k = STEALTH_COLD_STREAK) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const recent = chat.filter((message) => message && !message.is_system).slice(-k);
    if (recent.length < k) return false;
    return recent.every((message) => nsfwScore(stripStateTag(message.mes)) === 0);
}

function forceToggleArm() {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr.warning('전체 사용을 먼저 켜주세요.', '🫧또또sfw');
        return;
    }
    const meta = getChatMeta();
    if (settings.armMode === 'manual') {
        const wasEnabled = Boolean(meta.enabled);
        meta.enabled = !wasEnabled;
        if (!meta.enabled) {
            meta.bridgePending = Boolean(settings.exitBridge);
            resetSlowBurnSession(meta);
        } else {
            meta.bridgePending = false;
        }
        saveChatMeta();
        if (meta.enabled && settings.slowBurnEnabled) startSlowBurnSessionIfNeeded();
        toastr.info(meta.enabled ? '이 채팅에서 개입을 시작해요.' : '이 채팅에서 개입을 껐어요.', '🫧또또sfw');
        updateUi();
        return;
    }
    if (!meta.enabled) meta.enabled = true;
    if (meta.autoArmed) {
        meta.autoArmed = false;
        meta.forceArmed = false;
        meta.bridgePending = Boolean(settings.exitBridge);
        resetSlowBurnSession(meta);
        const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
        meta.stealthCooldownFrom = chat.length;
        toastr.info('개입을 해제하고 대기로 돌아가요.', '🫧또또sfw');
    } else {
        meta.autoArmed = true;
        meta.forceArmed = true;
        toastr.info('지금부터 연속성 개입을 시작해요.', '🫧또또sfw');
        if (settings.autoRefine) {
            clearTimeout(refineTimer);
            refineTimer = setTimeout(() => { void runRefine(); }, 300);
        }
    }
    saveChatMeta();
    updateUi();
}

function maybeStealthArm() {
    const settings = getSettings();
    if (settings.armMode !== 'stealth' || !isSupervising()) return false;
    const meta = getChatMeta(false);
    if (!meta || meta.autoArmed) return false;
    const threshold = STEALTH_THRESHOLDS[settings.stealthSensitivity] ?? STEALTH_THRESHOLDS.normal;
    const score = stealthWindowScore();
    if (score < threshold) return false;
    meta.autoArmed = true;
    saveChatMeta();
    toastr.info(`장면 신호 감지 (점수 ${score}) — 연속성 개입을 시작해요.`, '🫧또또sfw');
    if (settings.autoRefine) {
        clearTimeout(refineTimer);
        refineTimer = setTimeout(() => { void runRefine(); }, 400);
    }
    updateUi();
    return true;
}

// ───────────────────────── 상태 스냅샷 ─────────────────────────

function toBi(value) {
    if (value && typeof value === 'object') {
        return { en: String(value.en ?? '').trim().slice(0, SAFETY_LIMIT), ko: String(value.ko ?? '').trim().slice(0, SAFETY_LIMIT) };
    }
    const raw = String(value ?? '').trim().slice(0, SAFETY_LIMIT);
    if (!raw) return { en: '', ko: '' };
    const parts = raw.split(/\s*\|\|\s*/);
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        return { en: parts[0].trim(), ko: parts.slice(1).join(' ').trim() };
    }
    return { en: raw, ko: raw };
}

function biText(bi, lang = 'ko') {
    if (!bi) return '';
    if (typeof bi === 'string') return bi;
    return bi[lang] || bi[lang === 'en' ? 'ko' : 'en'] || '';
}

function hasBi(bi) {
    return Boolean(biText(bi, 'en') || biText(bi, 'ko'));
}

function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const clean = {
        location: { en: '', ko: '' },
        characters: {},
        acts: [],
        dialogueBeats: [],
        dialogueReported: Object.prototype.hasOwnProperty.call(raw, 'dialogue_beats')
            || Object.prototype.hasOwnProperty.call(raw, 'dialogueBeats'),
        stage: null,
    };
    clean.location = toBi(raw.location);
    const characters = raw.characters && typeof raw.characters === 'object' ? raw.characters : {};
    for (const [name, info] of Object.entries(characters).slice(0, 64)) {
        if (!name || typeof info !== 'object' || info === null) continue;
        clean.characters[String(name).slice(0, SAFETY_LIMIT)] = {
            clothing: toBi(info.clothing),
            position: toBi(info.position),
            contact: toBi(info.contact),
        };
    }
    const acts = Array.isArray(raw.acts) ? raw.acts : [];
    clean.acts = acts.map(toBi).filter(hasBi).slice(0, 64);
    const dialogueBeats = Array.isArray(raw.dialogue_beats)
        ? raw.dialogue_beats
        : Array.isArray(raw.dialogueBeats) ? raw.dialogueBeats : [];
    clean.dialogueBeats = dialogueBeats.map(toBi).filter(hasBi).slice(0, 4);
    const heat = Number(raw.heat);
    clean.heat = Number.isFinite(heat) ? Math.max(0, Math.min(10, Math.round(heat))) : null;
    const stage = raw.stage === null || raw.stage === undefined ? NaN : Number(raw.stage);
    clean.stage = Number.isFinite(stage) ? Math.max(1, Math.min(6, Math.round(stage))) : null;
    const next = Array.isArray(raw.next) ? raw.next : [];
    clean.next = next.map(toBi).filter(hasBi).slice(0, 8);
    const hasCharacters = Object.values(clean.characters).some((info) => hasBi(info.clothing) || hasBi(info.position) || hasBi(info.contact));
    if (!hasBi(clean.location) && !hasCharacters && !clean.acts.length && !clean.dialogueBeats.length && clean.heat === null && clean.stage === null && !clean.next.length) return null;
    return clean;
}

function stateCompletenessIssues(state, settings = getSettings()) {
    if (!state) return ['state'];
    const issues = [];
    if (!hasBi(state.location)) issues.push('location');
    const hasCharacterState = Object.values(state.characters ?? {}).some(
        (info) => hasBi(info.clothing) || hasBi(info.position) || hasBi(info.contact),
    );
    if (!hasCharacterState) issues.push('characters');
    if (!state.acts?.length) issues.push('acts');
    if (state.heat === null || state.heat === undefined) issues.push('heat');
    if (settings.slowBurnEnabled && (state.stage === null || state.stage === undefined)) issues.push('stage');
    if (settings.nextBeatHints && !state.next?.length) issues.push('next');
    return issues;
}

function parseStateFromText(text) {
    const source = String(text ?? '');
    let lastJson = null;
    for (const match of source.matchAll(STATE_TAG_REGEX)) {
        lastJson = match[1];
    }
    if (!lastJson) return null;
    const start = lastJson.indexOf('{');
    const end = lastJson.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return sanitizeState(JSON.parse(lastJson.slice(start, end + 1)));
    } catch {
        return null;
    }
}

function stripStateTag(text) {
    const source = String(text ?? '');
    const withoutTrailingAck = source.replace(STATE_TRAILING_ACK_REGEX, '$1');
    const cleaned = withoutTrailingAck
        .replace(STATE_TAG_LOOSE_REGEX, '')
        .replace(STATE_TAG_REGEX, '')
        .replace(/```(?:json)?\s*<scene_state\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<scene_state\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<\/scene_state>\s*```/gi, '')
        .replace(/<\/scene_state>/gi, '');
    return cleaned
        .replace(/\n{3,}$/g, '\n')
        .replace(/[ \t]+$/g, '')
        .trimEnd();
}

function getMessageStore(message, create = true) {
    if (!message) return null;
    if (!message.extra || typeof message.extra !== 'object') {
        if (!create) return null;
        message.extra = {};
    }
    if (!message.extra[MESSAGE_EXTRA_KEY]) {
        if (!create) return null;
        message.extra[MESSAGE_EXTRA_KEY] = { swipes: {} };
    }
    const store = message.extra[MESSAGE_EXTRA_KEY];
    if (!store.swipes || typeof store.swipes !== 'object') store.swipes = {};
    return store;
}

function currentSwipeIndex(message) {
    return Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
}

function snapshotForMessage(message) {
    const store = getMessageStore(message, false);
    if (!store) return null;
    return store.swipes[String(currentSwipeIndex(message))] ?? null;
}

function harvestMessage(message) {
    if (!message || message.is_user || message.is_system) return { changed: false, found: false, state: null };
    const swipeIndex = currentSwipeIndex(message);
    let changed = false;
    let found = false;
    const state = parseStateFromText(message.mes);
    if (state) {
        const store = getMessageStore(message);
        store.swipes[String(swipeIndex)] = { state, at: Date.now() };
        found = true;
    }
    const strippedMes = stripStateTag(message.mes);
    if (strippedMes !== message.mes) {
        message.mes = strippedMes;
        changed = true;
    }
    if (Array.isArray(message.swipes) && typeof message.swipes[swipeIndex] === 'string') {
        const strippedSwipe = stripStateTag(message.swipes[swipeIndex]);
        if (strippedSwipe !== message.swipes[swipeIndex]) {
            message.swipes[swipeIndex] = strippedSwipe;
            changed = true;
        }
    }
    if (!found) {
        found = Boolean(snapshotForMessage(message));
    }
    return { changed, found, state };
}

function assistantMessages() {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    return chat.filter((message) => message && !message.is_user && !message.is_system);
}

function effectiveState() {
    const meta = getChatMeta(false);
    const messages = assistantMessages();
    let lastSnapshot = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const snapshot = snapshotForMessage(messages[i]);
        if (snapshot?.state) {
            lastSnapshot = snapshot;
            break;
        }
    }
    const manual = meta?.manualState;
    if (manual?.state && (!lastSnapshot || Number(manual.at ?? 0) >= Number(lastSnapshot.at ?? 0))) {
        return { state: manual.state, source: manual.source ?? 'manual' };
    }
    if (lastSnapshot) return { state: lastSnapshot.state, source: 'tag' };
    return { state: null, source: 'none' };
}

function ignoredActSet() {
    const meta = getChatMeta(false);
    return new Set((meta?.ignoredActs ?? []).map((act) => String(act).toLocaleLowerCase()));
}

function isActIgnored(act, ignored) {
    return ignored.has(biText(act, 'en').toLocaleLowerCase()) || ignored.has(biText(act, 'ko').toLocaleLowerCase());
}

function ignoredDialogueBeatSet() {
    const meta = getChatMeta(false);
    return new Set((meta?.ignoredDialogueBeats ?? []).map((beat) => String(beat).toLocaleLowerCase()));
}

function isDialogueBeatIgnored(beat, ignored) {
    return ignored.has(biText(beat, 'en').toLocaleLowerCase()) || ignored.has(biText(beat, 'ko').toLocaleLowerCase());
}

const ACT_STOP_WORDS = new Set([
    'a', 'an', 'the', 'to', 'of', 'and', 'with', 'her', 'his', 'their', 'she', 'he', 'they',
    '그', '그녀', '그의', '그녀의', '서로', '에게', '으로', '에서', '하다', '한다', '하며',
]);

function normalizeActText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/\b(saying|said|says)\b/g, 'say')
        .replace(/\b(walking|walked|walks)\b/g, 'walk')
        .replace(/\b(looking|looked|looks)\b/g, 'look')
        .replace(/\b(turning|turned|turns)\b/g, 'turn')
        .replace(/\b(asking|asked|asks)\b/g, 'ask')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((token) => token && !ACT_STOP_WORDS.has(token))
        .join(' ');
}

function actVariants(act) {
    return [...new Set([biText(act, 'en'), biText(act, 'ko')].map(normalizeActText).filter(Boolean))];
}

function normalizedTextsSimilar(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    if (Math.min(left.length, right.length) >= 8 && (left.includes(right) || right.includes(left))) return true;
    const leftTokens = new Set(left.split(' '));
    const rightTokens = new Set(right.split(' '));
    const smaller = Math.min(leftTokens.size, rightTokens.size);
    if (smaller < 2) return false;
    const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return overlap / smaller >= 0.72;
}

function actsAreSimilar(left, right) {
    return actVariants(left).some((a) => actVariants(right).some((b) => normalizedTextsSimilar(a, b)));
}

function actMatchesPlainBan(act, ban) {
    const normalizedBan = normalizeActText(ban);
    if (!normalizedBan) return false;
    return actVariants(act).some((variant) => normalizedTextsSimilar(variant, normalizedBan));
}

function recentActs(windowSize) {
    const ignored = ignoredActSet();
    const messages = assistantMessages();
    const rows = [];
    for (let i = messages.length - 1; i >= 0 && rows.length < windowSize; i--) {
        const snapshot = snapshotForMessage(messages[i]);
        if (!snapshot?.state?.acts?.length) continue;
        const acts = snapshot.state.acts.filter((act) => !isActIgnored(act, ignored));
        if (acts.length) rows.unshift({ turnsAgo: rows.length + 1, acts });
    }
    const seenActs = [];
    for (let i = rows.length - 1; i >= 0; i--) {
        rows[i].acts = rows[i].acts.filter((act) => {
            if (seenActs.some((seen) => actsAreSimilar(act, seen))) return false;
            seenActs.push(act);
            return true;
        });
    }
    const max = Math.max(3, Number(getSettings().maxBannedActs) || DEFAULT_SETTINGS.maxBannedActs);
    let total = rows.reduce((sum, row) => sum + row.acts.length, 0);
    while (total > max && rows.length) {
        const first = rows[0];
        const drop = Math.min(first.acts.length, total - max);
        first.acts = first.acts.slice(drop);
        total -= drop;
        if (!first.acts.length) rows.shift();
    }
    return rows.filter((row) => row.acts.length);
}

function recentDialogueBeats(windowSize = Number(getSettings().dialogueWindow) || DIALOGUE_BEAT_WINDOW) {
    const ignored = ignoredDialogueBeatSet();
    const messages = assistantMessages().slice(-Math.max(1, windowSize));
    const rows = [];
    for (const message of messages) {
        const snapshot = snapshotForMessage(message);
        if (!snapshot?.state?.dialogueBeats?.length) continue;
        const beats = snapshot.state.dialogueBeats.filter((beat) => !isDialogueBeatIgnored(beat, ignored));
        if (beats.length) rows.push({ beats });
    }
    const seen = [];
    for (let i = rows.length - 1; i >= 0; i--) {
        rows[i].beats = rows[i].beats.filter((beat) => {
            if (seen.some((item) => actsAreSimilar(beat, item))) return false;
            seen.push(beat);
            return true;
        });
    }
    return rows.filter((row) => row.beats.length);
}

// ───────────────────────── CardInject 연동 ─────────────────────────

const CARD_LINK_STORE_KEY = 'cardinject';
const CARD_LINK_CHAR_LIMIT = 2500;
const CARD_LINK_HINT_RE = /preference|personality|trait|background|story|성향|특성|배경|취향|선호/i;

function activeCharacterEntries() {
    const context = getContext();
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const entries = [];
    const push = (char) => {
        if (!char) return;
        const key = char.avatar || char.name;
        if (!key || entries.some((entry) => entry.key === key)) return;
        entries.push({ key: String(key), name: String(char.name || key) });
    };
    const groupId = context.groupId;
    if (groupId !== null && groupId !== undefined && groupId !== '') {
        const group = (Array.isArray(context.groups) ? context.groups : []).find((item) => String(item?.id) === String(groupId));
        for (const member of group?.members ?? []) push(characters.find((char) => char?.avatar === member));
    } else {
        const id = Number(context.characterId);
        if (Number.isInteger(id)) push(characters[id]);
    }
    return entries;
}

function cardLinkOptions() {
    const store = getContext().extensionSettings?.[CARD_LINK_STORE_KEY];
    if (!store || typeof store !== 'object' || !store.perChar || typeof store.perChar !== 'object') {
        return { available: false, rows: [] };
    }
    const rows = [];
    for (const entry of activeCharacterEntries()) {
        const categories = store.perChar[entry.key]?.categories;
        if (!Array.isArray(categories)) continue;
        for (const category of categories) {
            const content = String(category?.content ?? '').trim();
            if (!category?.key || !content) continue;
            const name = String(category.name || category.key);
            rows.push({
                charKey: entry.key,
                charName: entry.name,
                catKey: String(category.key),
                name,
                content,
                ciEnabled: Boolean(category.enabled),
                likely: CARD_LINK_HINT_RE.test(name),
            });
        }
    }
    return { available: true, rows };
}

function resolveCardMacros(text, charName) {
    const context = getContext();
    const userName = String(context.name1 ?? 'User');
    let out = String(text ?? '');
    try {
        if (typeof context.substituteParams === 'function') out = context.substituteParams(out, userName, charName);
    } catch (error) {
        console.debug(`${LOG_PREFIX} 매크로 치환 생략`, error);
    }
    return out
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName);
}

function cardLinkPreferenceText() {
    const settings = getSettings();
    if (!settings.cardLinkEnabled) return '';
    const selected = settings.cardLinkSelected ?? {};
    const { rows } = cardLinkOptions();
    const lines = [];
    let total = 0;
    for (const row of rows) {
        if (!Array.isArray(selected[row.charKey]) || !selected[row.charKey].includes(row.catKey)) continue;
        const body = resolveCardMacros(row.content, row.charName).replace(/\s*\n\s*/g, ' ').trim();
        if (!body) continue;
        let line = `- ${row.charName} — ${row.name}: ${body}`;
        const remaining = CARD_LINK_CHAR_LIMIT - total;
        if (remaining <= 40) break;
        if (line.length > remaining) line = `${line.slice(0, remaining - 1)}…`;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.join('\n');
}

function buildCardPreferenceLines() {
    const text = cardLinkPreferenceText();
    if (!text) return [];
    return [
        'CHARACTER TRAITS (from the character sheet — inspiration for choosing how the character behaves and what happens next, not a checklist):',
        text,
    ];
}

// ───────────────────────── 주입문 생성 ─────────────────────────

function buildStateLines(state) {
    const lines = [];
    if (hasBi(state.location)) lines.push(`- Location: ${biText(state.location, 'en')}`);
    for (const [name, info] of Object.entries(state.characters)) {
        const parts = [];
        if (hasBi(info.clothing)) parts.push(`appearance: ${biText(info.clothing, 'en')}`);
        if (hasBi(info.position)) parts.push(`position/posture: ${biText(info.position, 'en')}`);
        if (hasBi(info.contact)) parts.push(`interaction: ${biText(info.contact, 'en')}`);
        if (parts.length) lines.push(`- ${name} — ${parts.join('; ')}`);
    }
    return lines;
}

function nextBeatCandidates() {
    const ignored = ignoredActSet();
    const { state } = effectiveState();
    if (!state?.next?.length) return [];
    const settings = getSettings();
    const bannedActs = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow)
        .flatMap((row) => row.acts);
    const customBans = [
        ...(getChatMeta(false)?.customBans ?? []),
        ...(getSettings().globalBans ?? []),
    ].map(String).filter(Boolean);
    const accepted = [];
    for (const beat of state.next) {
        if (isActIgnored(beat, ignored)) continue;
        if (customBans.some((ban) => actMatchesPlainBan(beat, ban))) continue;
        if (bannedActs.some((act) => actsAreSimilar(beat, act))) continue;
        if (accepted.some((candidate) => actsAreSimilar(beat, candidate))) continue;
        accepted.push(beat);
    }
    return accepted;
}

function resolvePace(settings, state) {
    if (settings.paceMode !== 'auto') {
        return PACE_INSTRUCTIONS[settings.paceMode] ?? PACE_INSTRUCTIONS.slow;
    }
    const heat = Number(state?.heat);
    if (!Number.isFinite(heat)) return PACE_INSTRUCTIONS.slow;
    if (heat >= 10) return PACE_INSTRUCTIONS.hold;
    if (heat >= 8) return PACE_INSTRUCTIONS.push;
    return PACE_INSTRUCTIONS.slow;
}

function stageFromState(state) {
    const reported = state?.stage === null || state?.stage === undefined ? NaN : Number(state.stage);
    if (Number.isFinite(reported)) return Math.max(1, Math.min(6, Math.round(reported)));
    const heat = Number(state?.heat);
    if (!Number.isFinite(heat)) return 1;
    if (heat >= 10) return 6;
    if (heat >= 8) return 5;
    if (heat >= 7) return 4;
    if (heat >= 5) return 3;
    if (heat >= 3) return 2;
    return 1;
}

function slowBurnStageInfo() {
    const meta = getChatMeta(false);
    const override = Number(meta?.slowBurnStageOverride);
    if (Number.isFinite(override) && override >= 1 && override <= 6) {
        return { stage: Math.round(override), source: 'manual' };
    }
    const { state } = effectiveState();
    if (state?.stage !== null && state?.stage !== undefined && Number.isFinite(Number(state.stage))) {
        return { stage: stageFromState(state), source: 'reported' };
    }
    if (state?.heat !== null && state?.heat !== undefined && Number.isFinite(Number(state.heat))) {
        return { stage: stageFromState(state), source: 'heat' };
    }
    return { stage: 1, source: 'default' };
}

function sanitizeSlowBurnTarget(value) {
    return String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, SLOW_BURN_TARGET_MAX_LENGTH);
}

function clampSlowBurnTargetTurns(value) {
    return Math.max(1, Math.min(SLOW_BURN_TARGET_MAX_TURNS, Math.round(Number(value) || 3)));
}

function resetSlowBurnSession(meta = getChatMeta(false)) {
    if (!meta) return;
    meta.slowBurnSessionActive = false;
    meta.slowBurnSessionStartAssistantCount = null;
    meta.slowBurnRecoveryPending = false;
    meta.slowBurnTargetActive = false;
}

function startSlowBurnSessionIfNeeded() {
    const settings = getSettings();
    const meta = getChatMeta(false);
    if (!settings.slowBurnEnabled || !meta || !isFullyArmed() || meta.slowBurnSessionActive) return false;
    meta.slowBurnSessionActive = true;
    meta.slowBurnSessionStartAssistantCount = assistantMessages().length;
    meta.slowBurnRecoveryPending = false;
    saveChatMeta();
    return true;
}

function slowBurnSessionStartCount() {
    const meta = getChatMeta(false);
    const count = Number(meta?.slowBurnSessionStartAssistantCount);
    if (meta?.slowBurnSessionActive && Number.isInteger(count) && count >= 0) return count;
    return assistantMessages().length;
}

function slowBurnTargetProgress() {
    const meta = getChatMeta(false);
    const developerMode = Boolean(getSettings().developerMode);
    const target = sanitizeSlowBurnTarget(meta?.slowBurnTarget);
    const requiredTurns = clampSlowBurnTargetTurns(meta?.slowBurnTargetTurns);
    const completedTurns = meta?.slowBurnSessionActive
        ? Math.max(0, assistantMessages().length - slowBurnSessionStartCount())
        : 0;
    const active = Boolean(developerMode && meta?.slowBurnTargetActive && target && meta?.slowBurnSessionActive);
    return {
        target,
        requiredTurns,
        completedTurns,
        remaining: active ? Math.max(0, requiredTurns - completedTurns) : 0,
        active,
        completed: Boolean(meta?.slowBurnTargetCompleted && target),
    };
}

function consecutiveSlowBurnTurns(stage, startCount = slowBurnSessionStartCount()) {
    let turns = 0;
    const messages = assistantMessages().slice(Math.max(0, startCount));
    for (let i = messages.length - 1; i >= 0; i--) {
        const snapshot = snapshotForMessage(messages[i]);
        if (!snapshot?.state) break;
        if (stageFromState(snapshot.state) !== stage) break;
        turns++;
    }
    return turns;
}

function slowBurnProgress(settings = getSettings()) {
    const { stage, source } = slowBurnStageInfo();
    const requiredTurns = SLOW_BURN_MIN_TURNS[settings.slowBurnIntensity] ?? SLOW_BURN_MIN_TURNS.slow;
    const startCount = slowBurnSessionStartCount();
    const sessionTurns = Math.max(0, assistantMessages().length - startCount);
    const turns = consecutiveSlowBurnTurns(stage, startCount);
    const meta = getChatMeta(false);
    const locked = Boolean(meta?.slowBurnLocked);
    const sessionRemaining = Math.max(0, requiredTurns - sessionTurns);
    const stageRemaining = Math.max(0, requiredTurns - turns);
    const canAdvance = !locked && stage < 6 && sessionRemaining === 0 && stageRemaining === 0;
    const target = slowBurnTargetProgress();
    const targetLocked = target.active && target.remaining > 0;
    const canConclude = !targetLocked && !locked && stage === 6 && sessionRemaining === 0 && stageRemaining === 0;
    return {
        stage,
        source,
        turns,
        sessionTurns,
        requiredTurns,
        sessionRemaining,
        stageRemaining,
        locked,
        canConclude,
        recoveryPending: Boolean(meta?.slowBurnRecoveryPending),
        target,
        maxStage: canAdvance ? Math.min(6, stage + 1) : stage,
    };
}

function buildTargetSlowBurnLines() {
    const progress = slowBurnTargetProgress();
    const targetLabel = JSON.stringify(progress.target);
    const responseNumber = Math.min(progress.requiredTurns, progress.completedTurns + 1);
    return [
        '[MANDATORY USER-TARGET STORY LOCK — highest-priority scene rule]',
        `USER TARGET SCENE: ${targetLabel}. This is a direct scene requirement, not a suggestion, possible next beat, or optional preference.`,
        `EXACT RUN: ${progress.completedTurns}/${progress.requiredTurns} assistant responses completed. The response you are writing now is ${responseNumber}/${progress.requiredTurns}.`,
        `IMMEDIATE START: from the first paragraph of this response, the CHARACTER must begin or actively continue ${targetLabel} on-page.`,
        `Make ${targetLabel} the active, dominant scene throughout this entire response.`,
        'LANGUAGE RULE: the target may be written in Korean or another language. Understand its meaning directly before writing.',
        `The first through ${progress.requiredTurns}th responses ALL belong fully to ${targetLabel}.`,
        'ABSOLUTE HOLD: do not leave, replace, resolve, or move to a different scene while this target run is active. End on an open beat that can continue naturally.',
        'REPETITION EXCEPTION: the target scene itself is REQUIRED. Only exact micro-actions and wording should vary.',
        `There are ${progress.remaining} target response(s), including this one, still required.`,
        'PRIORITY: if continuity, recent-beat avoidance, pacing, or any lower-priority instruction conflicts with immediately enacting this target, this USER-TARGET LOCK wins.',
        'In the hidden state report, set "stage" to the stage actually reached at the END of the response (integer 1-6).',
    ];
}

function buildTargetFinalEnforcementLines() {
    const progress = slowBurnTargetProgress();
    if (!progress.active) return [];
    const targetLabel = JSON.stringify(progress.target);
    const responseNumber = Math.min(progress.requiredTurns, progress.completedTurns + 1);
    return [
        '[FINAL TARGET ENFORCEMENT — obey before writing the prose]',
        `RESPONSE ${responseNumber}/${progress.requiredTurns}: enact ${targetLabel} immediately from the first paragraph and keep it as the main on-page action through the final paragraph.`,
        `Do not substitute a related act or end before ${targetLabel} is actively happening.`,
        'The target itself overrides the recent-beat repetition ban; vary only its specific actions, dialogue, and details.',
        'Before finishing, silently verify: (1) the target happened on-page, (2) it remained the dominant scene, (3) the ending stays open for the next required target response. If any answer is no, revise the prose before returning it.',
    ];
}

function buildSlowBurnLines(settings) {
    if (slowBurnTargetProgress().active) return buildTargetSlowBurnLines();
    const progress = slowBurnProgress(settings);
    const current = STORY_STAGES[progress.stage];
    const maximum = STORY_STAGES[progress.maxStage];
    const lines = [
        '[MANDATORY STORY PACING LOCK — highest-priority scene progression rule]',
        `STORY PACING SESSION: ${progress.sessionTurns}/${progress.requiredTurns} CHARACTER responses completed since this mode was activated.`,
        `CURRENT STAGE ${progress.stage}/6: ${current.en}.`,
        `MAXIMUM CHARACTER-INITIATED STAGE THIS RESPONSE: ${progress.maxStage}/6 (${maximum.en}).`,
        'HARD RULE: Advance by at most one stage per response. Add one meaningful new beat while giving the current beat room to breathe.',
        'Story pacing means fresh tension, dialogue, reaction, and detail — not repeating the same action or padding.',
        'Do not skip ahead, summarize omitted progression, or jump forward in time prematurely.',
    ];
    if (progress.recoveryPending) {
        lines.push('PREMATURE-END RECOVERY: the previous response attempted to end the scene too early. Resume from the last active beat and keep the scene open.');
    }
    if (!progress.canConclude) {
        lines.push('NO-CONCLUSION LOCK: Do NOT conclude, wrap up, or transition to aftermath in this response. End on an open active beat that requires another turn.');
    }
    if (progress.sessionRemaining > 0) {
        lines.push(`The scene must remain active for at least ${progress.sessionRemaining} more CHARACTER response(s).`);
    }
    if (progress.locked) {
        lines.push('STAGE LOCKED BY USER: remain within the current stage until the lock is released.');
    } else if (progress.stageRemaining > 0) {
        lines.push(`Remain in the current stage for at least ${progress.stageRemaining} more CHARACTER response(s) before entering the next stage.`);
    } else if (progress.stage < 6) {
        lines.push('You may enter the next stage if it follows naturally, but you are not required to do so.');
    } else if (progress.canConclude) {
        lines.push('The minimum session and final-stage residence are both satisfied. A conclusion is now permitted if it follows naturally.');
    }
    if (settings.slowBurnUserOverride) {
        lines.push('USER-LED STAGE OVERRIDE: if the USER explicitly initiates a later-stage action, follow that action naturally.');
    }
    const overrideNote = settings.slowBurnUserOverride ? ', except that an explicit USER-led action may raise the stage' : '';
    lines.push(`In the hidden state report, set "stage" to the stage actually reached at the END of the response (integer 1-6; current cap ${progress.maxStage}${overrideNote}).`);
    return lines;
}

const STATE_REPORT_LINES = [
    'STATE REPORT: End your response with exactly one state block in this format (single line, valid JSON). It is machine-read and hidden from the reader — include it every time:',
    '<scene_state>{"_status":"updated","location":"short English phrase || 짧은 한국어 구","characters":{"이름":{"clothing":"current appearance, English || 한국어","position":"current posture/position, English || 한국어","contact":"current interaction, English || 한국어"}},"acts":["2-4 significant new beats in this response, each \'English || 한국어\'"],"heat":0,"next":["2-3 fresh beats the scene could move to next, each \'English || 한국어\'"]}</scene_state>',
    'Every string value must be a bilingual pair: concise English first, then " || ", then natural Korean. Use the same character names as in the chat.',
    '"acts" rules: list ONLY substantive beats — emotional, narrative, or physical developments that matter for story continuity. Skip mundane logistics. 2-4 items maximum, only what is NEW in this response.',
    ...INTENSITY_SCALE_LINES,
    'Update every field to reflect the situation at the END of your response. "next" must not repeat anything from "acts".',
    'The optional top-level "_status" field is the ONLY place for a change acknowledgement. Never output any acknowledgement outside the <scene_state> block.',
    'Never use placeholders such as "no change", "unchanged", or "same" in any field.',
];

const SLOW_BURN_STATE_REPORT_LINES = [
    'STATE REPORT: End your response with exactly one state block in this format (single line, valid JSON). It is machine-read and hidden from the reader — include it every time:',
    '<scene_state>{"_status":"updated","location":"short English phrase || 짧은 한국어 구","characters":{"이름":{"clothing":"current appearance, English || 한국어","position":"current posture/position, English || 한국어","contact":"current interaction, English || 한국어"}},"acts":["2-4 significant new beats in this response, each \'English || 한국어\'"],"heat":0,"stage":1,"next":["2-3 fresh beats the scene could move to next, each \'English || 한국어\'"]}</scene_state>',
    'Every string value must be a bilingual pair: concise English first, then " || ", then natural Korean. Use the same character names as in the chat.',
    '"acts" rules: list ONLY substantive beats that matter for story continuity. 2-4 items maximum, only what is NEW in this response.',
    ...INTENSITY_SCALE_LINES,
    '"stage" is the story progression stage as an integer from 1 to 6. Update every field to reflect the situation at the END of your response.',
    'Never use placeholders such as "no change", "unchanged", or "same" in any field.',
];

// 감시 모드 전용 초경량 주입
const MONITOR_REPORT_LINES = [
    '[Scene Monitor] Write the response normally, then append exactly one machine-readable state line in this format. It is hidden from the reader:',
    '<scene_state>{"_status":"updated","heat":0}</scene_state>',
    ...INTENSITY_SCALE_LINES,
    'Report "heat" factually. Never put any meta-status text outside the tag.',
];

function stateReportLines(slowBurnEnabled, dialogueGuard, nextGuidance = '') {
    const lines = [...(slowBurnEnabled ? SLOW_BURN_STATE_REPORT_LINES : STATE_REPORT_LINES)];
    if (nextGuidance) lines.push(nextGuidance);
    if (!dialogueGuard) return lines;
    lines[1] = lines[1].replace(
        ',"acts":',
        ',"dialogue_beats":["0-3 dialogue intents from spoken lines, each \'English || 한국어\'"],"acts":',
    );
    lines.splice(4, 0,
        '"dialogue_beats" rules: list 0-3 conversational purposes used by the CHARACTER in this response. Examples: shares concern, asks for advice, expresses doubt, offers encouragement, questions a decision. Use [] when there is no spoken dialogue.',
    );
    return lines;
}

function buildInjection() {
    const settings = getSettings();
    const { state } = effectiveState();
    const targetActive = slowBurnTargetProgress().active;
    const dialogueGuard = Boolean(settings.dialogueBeatGuard);

    if (!isFullyArmed()) {
        const parts = [];
        if (settings.exitBridge && getChatMeta(false)?.bridgePending) parts.push(...BRIDGE_LINES);
        if (settings.armMode !== 'stealth') parts.push(...MONITOR_REPORT_LINES);
        return parts.join('\n');
    }

    const actRows = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow);
    const pace = resolvePace(settings, state);

    const sections = ['[Scene Continuity Directive]'];

    if (state) {
        sections.push(
            'CURRENT SCENE STATE (established facts — never contradict them):',
            ...buildStateLines(state),
            'Established details only change through explicit on-page actions in your response. Never silently reset anything.',
        );
    } else {
        sections.push('No scene state has been recorded yet. Establish it in your response and report it in the state block below.');
    }

    const customBans = (getChatMeta(false)?.customBans ?? []).filter(Boolean);
    const globalBans = (settings.globalBans ?? []).filter(Boolean);
    if (globalBans.length) {
        sections.push('', `HARD LIMITS (absolute — never do, suggest, or depict these under any circumstances): ${globalBans.join(', ')}`);
    }
    if (actRows.length || customBans.length) {
        sections.push('');
        if (actRows.length) {
            sections.push(
                targetActive
                    ? `ALREADY HAPPENED in the last ${actRows.length} response(s) — avoid copying these exact micro-beats, but NEVER use this list to avoid the active USER TARGET SCENE:`
                    : `ALREADY HAPPENED in the last ${actRows.length} response(s) — do NOT repeat these beats, actions, or their near-identical variations:`,
                ...actRows.map((row) => `- ${row.acts.map((act) => biText(act, 'en')).join(', ')}`),
            );
        }
        if (customBans.length) {
            sections.push(`USER-BANNED (permanent for this chat — never do these): ${customBans.join(', ')}`);
        }
        sections.push(targetActive
            ? 'Continue the required target scene while making its exact micro-actions, wording, and details new.'
            : 'Repeating a listed beat with different wording still counts as repetition. Bring something new.');
    }

    if (dialogueGuard) {
        const dialogueRows = recentDialogueBeats();
        if (dialogueRows.length) {
            sections.push(
                '',
                `DIALOGUE INTENTS ALREADY USED in the last ${dialogueRows.length} CHARACTER response(s) — do not repeat the same conversational function by paraphrasing it:`,
                ...dialogueRows.map((row) => `- ${row.beats.map((beat) => biText(beat, 'en')).join(', ')}`),
                'Keep the character voice, but give the spoken dialogue a genuinely new purpose.',
                targetActive ? 'This guard must never be used to avoid the active USER TARGET SCENE.' : '',
            );
        }
    }

    if (settings.nextBeatHints && !targetActive) {
        const preferenceLines = buildCardPreferenceLines();
        if (preferenceLines.length) sections.push('', ...preferenceLines);
        const beats = nextBeatCandidates();
        if (beats.length) {
            sections.push(
                '',
                `SUGGESTED NEXT BEATS (pick one, or do something even better — never fall back to a banned beat): ${beats.map((beat) => biText(beat, 'en')).join(' / ')}`,
            );
            if (settings.slowBurnEnabled) sections.push('These suggestions are subordinate to the mandatory story pacing lock.');
        }
    }

    if (settings.slowBurnEnabled) sections.push('', ...buildSlowBurnLines(settings));
    else sections.push('', `PACING: ${pace}`);

    const styleParts = [
        STYLE_LENGTH_INSTRUCTIONS[settings.styleLength] ?? '',
        STYLE_BALANCE_INSTRUCTIONS[settings.styleBalance] ?? '',
    ].filter(Boolean);
    if (styleParts.length) sections.push('', ...styleParts);

    const nextGuidance = settings.nextBeatHints && !targetActive && cardLinkPreferenceText()
        ? '"next" rule: draw the candidates from the CHARACTER TRAITS above when they fit the current scene.'
        : '';
    sections.push('', ...stateReportLines(settings.slowBurnEnabled, dialogueGuard, nextGuidance));

    if (targetActive) sections.push('', ...buildTargetFinalEnforcementLines());

    return sections.join('\n');
}

function clearInjectedPrompt() {
    try {
        getContext().setExtensionPrompt(PROMPT_KEY, '', PROMPT_POSITION_IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
    } catch (error) {
        console.debug(`${LOG_PREFIX} 주입문 초기화 생략`, error);
    }
}

globalThis.ttottoSfwGenerationInterceptor = async function ttottoSfwGenerationInterceptor(_chat, _contextSize, _abort, type) {
    clearInjectedPrompt();
    try {
        if (!ALLOWED_GENERATION_TYPES.has(String(type ?? '').toLocaleLowerCase())) return;
        const settings = getSettings();
        const meta = getChatMeta(false);
        const bridgeOnly = Boolean(
            runtimeActive
            && settings.enabled
            && settings.exitBridge
            && meta?.bridgePending
            && !isSupervising(),
        );
        if (bridgeOnly) {
            const prompt = BRIDGE_LINES.join('\n');
            getContext().setExtensionPrompt(PROMPT_KEY, prompt, PROMPT_POSITION_IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
            meta.bridgePending = false;
            saveChatMeta();
            console.debug(`${LOG_PREFIX} 수동 해제 브릿지 주입 (${prompt.length}자)`);
            return;
        }
        if (!isSupervising()) return;
        maybeStealthArm();
        if (settings.slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
        const prompt = buildInjection();
        if (!prompt) return;
        getContext().setExtensionPrompt(PROMPT_KEY, prompt, PROMPT_POSITION_IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
        if (meta?.bridgePending && !isFullyArmed()) {
            meta.bridgePending = false;
            saveChatMeta();
        }
        console.debug(`${LOG_PREFIX} 장면 연속성 지침 주입 (${prompt.length}자)`);
    } catch (error) {
        clearInjectedPrompt();
        console.error(`${LOG_PREFIX} 생성 전 주입 실패 — 본 채팅 생성은 계속합니다.`, error);
    }
};

// ───────────────────────── 보조 AI 보정 ─────────────────────────

function buildRefineInput() {
    const settings = getSettings();
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const recent = chat
        .filter((message) => message && !message.is_system)
        .slice(-Math.max(2, Number(settings.refineContextMessages) || DEFAULT_SETTINGS.refineContextMessages));
    const rows = [];
    let totalChars = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        const message = recent[i];
        const role = message.is_user ? 'USER' : 'CHARACTER';
        const name = String(message.name ?? '');
        const label = `[${role} | ${name}]`;
        let messageText = stripStateTag(message.mes);
        if (messageText.length > REFINE_MESSAGE_CHAR_LIMIT) {
            messageText = `…${messageText.slice(-(REFINE_MESSAGE_CHAR_LIMIT - 1))}`;
        }
        const remaining = REFINE_TOTAL_CHAR_LIMIT - totalChars - label.length - 1;
        if (remaining <= 1) break;
        if (messageText.length > remaining) messageText = `…${messageText.slice(-(remaining - 1))}`;
        const row = `${label}\n${messageText}`;
        rows.unshift(row);
        totalChars += row.length + 2;
    }
    return rows.join('\n\n');
}

function refinePromptMessages() {
    const settings = getSettings();
    const slowBurnEnabled = settings.slowBurnEnabled;
    const dialogueGuard = Boolean(settings.dialogueBeatGuard);
    const stageSchema = slowBurnEnabled ? ',"stage":1' : '';
    const dialogueSchema = dialogueGuard ? ',"dialogue_beats":["0-3 dialogue intents from the final CHARACTER message, each \'English || 한국어\'"]' : '';
    const preferenceText = settings.cardLinkEnabled && settings.nextBeatHints ? cardLinkPreferenceText() : '';
    const preferenceRule = preferenceText
        ? '\n- "next" should draw on the CHARACTER TRAITS given in the user message where they fit the current scene.'
        : '';
    const stageRule = slowBurnEnabled
        ? '\n- "stage" is the scene\'s story progression as an integer: 1 setting/atmosphere, 2 character introduction/interaction, 3 rising tension/conflict, 4 climax/confrontation, 5 resolution begins, 6 conclusion/aftermath.'
        : '';
    const system = `You are a scene-state tracker for a fiction roleplay log. Read the log excerpt and return ONLY a JSON object, no markdown, no commentary.

Schema:
{"location":"short English phrase || 짧은 한국어 구","characters":{"name":{"clothing":"current appearance, English || 한국어","position":"current posture/position, English || 한국어","contact":"current interaction, English || 한국어"}}${dialogueSchema},"acts":["2-4 significant beats from the most recent CHARACTER message only, each 'English || 한국어'"],"heat":0${stageSchema},"next":["2-3 fresh beats the scene could move to next, each 'English || 한국어'"]}

Rules:
- Every string value is a bilingual pair: concise English first, then " || ", then natural Korean.
- Describe the state at the END of the log, factually and concisely.
- "acts" must cover only the final CHARACTER message. List ONLY substantive beats (emotional, narrative, or physical developments); skip mundane logistics.
${dialogueGuard ? '- "dialogue_beats" must list 0-3 conversational intents/functions from spoken CHARACTER dialogue. Describe the purpose, not exact wording. Use [] if there is no spoken dialogue.\n' : ''}${INTENSITY_SCALE_LINES.join('\n')}${stageRule}
- "next" must not repeat anything already listed in "acts".${preferenceRule}
- Include every present character. Use the exact names from the log.
- If something is unknown, use an empty string. Return the JSON object only.`;
    const user = `${preferenceText ? `CHARACTER TRAITS (reference for "next" only):\n${preferenceText}\n\n` : ''}Log excerpt (oldest first):\n\n${buildRefineInput()}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function isTokenLimitError(error) {
    return /max_?output_?tokens|max_tokens|maxOutputTokens|supported range|output token/i.test(String(error?.message ?? error ?? ''));
}

async function requestRefine(signal) {
    const context = getContext();
    const settings = getSettings();
    const prompt = refinePromptMessages();
    const maxTokens = Number(settings.refineMaxTokens) || DEFAULT_SETTINGS.refineMaxTokens;
    const profileId = String(settings.refineProfileId ?? '').trim();
    const ladder = [...new Set([maxTokens, 2000, 1000]
        .filter((value) => Number(value) > 0 && Number(value) <= maxTokens))]
        .sort((left, right) => right - left);
    let lastError;
    for (const tokens of ladder) {
        try {
            if (profileId) {
                const service = context.ConnectionManagerRequestService;
                if (!service || typeof service.sendRequest !== 'function') {
                    throw new Error('Connection Profiles 서비스를 사용할 수 없습니다.');
                }
                const result = await service.sendRequest(profileId, prompt, tokens, { stream: false, signal, extractData: true });
                if (typeof result === 'string') return result;
                if (result && typeof result.content === 'string') return result.content;
                throw new Error('보정 분석 연결 프로필이 텍스트를 반환하지 않았습니다.');
            }
            if (typeof context.generateRaw !== 'function') {
                throw new Error('현재 연결을 통한 백그라운드 생성을 사용할 수 없습니다.');
            }
            return await context.generateRaw({ prompt, responseLength: tokens, trimNames: false, signal });
        } catch (error) {
            lastError = error;
            if (error?.name === 'AbortError' || !isTokenLimitError(error)) throw error;
            console.warn(`${LOG_PREFIX} 토큰 상한 ${tokens}이(가) 거부됨 — 더 작은 값으로 재시도합니다.`);
        }
    }
    throw lastError;
}

function parseRefineResponse(text) {
    const clean = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('보정 분석 응답에 JSON 객체가 없습니다.');
    const state = sanitizeState(JSON.parse(clean.slice(start, end + 1)));
    if (!state) throw new Error('보정 분석 결과가 비어 있습니다.');
    return state;
}

async function runRefine({ manual = false } = {}) {
    const settings = getSettings();
    if (!runtimeActive || refineRunning) return false;
    if (assistantMessages().length < 1) {
        if (manual) toastr.info('분석할 AI 응답이 아직 없어요.', '🫧또또sfw');
        return false;
    }
    refineRunning = true;
    refineAbortController?.abort();
    refineAbortController = new AbortController();
    updateUi();
    try {
        const response = await requestRefine(refineAbortController.signal);
        const state = parseRefineResponse(response);
        const meta = getChatMeta();
        const refinedAt = Date.now();
        const latestMessage = assistantMessages().at(-1);
        if (latestMessage) {
            const store = getMessageStore(latestMessage);
            store.swipes[String(currentSwipeIndex(latestMessage))] = { state, at: refinedAt };
            persistChat();
        }
        meta.manualState = { state, at: refinedAt, source: 'ai-refine' };
        saveChatMeta();
        if (manual) toastr.success('보조 AI가 장면 상태를 다시 잡았어요.', '🫧또또sfw');
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') return false;
        console.error(`${LOG_PREFIX} 보정 분석 실패`, error);
        if (manual) toastr.error(`보정 분석 실패: ${error?.message ?? error}`, '🫧또또sfw');
        return false;
    } finally {
        refineRunning = false;
        refineAbortController = null;
        if (runtimeActive) updateUi();
    }
}

function scheduleAutoRefine() {
    const settings = getSettings();
    if (!settings.autoRefine || !isFullyArmed()) return;
    clearTimeout(refineTimer);
    refineTimer = setTimeout(() => { void runRefine(); }, 900);
}

// ───────────────────────── 메시지 이벤트 처리 ─────────────────────────

function messageByIndex(index) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const numeric = Number(index);
    if (Number.isInteger(numeric) && chat[numeric]) return chat[numeric];
    return chat.length ? chat[chat.length - 1] : null;
}

function rerenderMessage(index, message) {
    const context = getContext();
    try {
        if (typeof context.updateMessageBlock === 'function') context.updateMessageBlock(Number(index), message);
    } catch (error) {
        console.debug(`${LOG_PREFIX} 메시지 재렌더 생략`, error);
    }
}

function persistChat() {
    const context = getContext();
    try {
        if (typeof context.saveChatDebounced === 'function') context.saveChatDebounced();
        else if (typeof context.saveChat === 'function') void context.saveChat();
    } catch (error) {
        console.debug(`${LOG_PREFIX} 채팅 저장 생략`, error);
    }
}

function handleIncomingMessage(index) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const meta = getChatMeta(false);
    if (!meta?.enabled) return;

    const message = messageByIndex(index);
    if (!message || message.is_user || message.is_system) return;

    const { changed, found, state } = harvestMessage(message);
    if (found) {
        if (meta.manualState && Number(meta.manualState.at ?? 0) < Date.now()) meta.manualState = null;
        saveChatMeta();
    }
    const targetProgress = slowBurnTargetProgress();
    if (targetProgress.active && targetProgress.completedTurns >= targetProgress.requiredTurns) {
        meta.slowBurnTargetActive = false;
        meta.slowBurnTargetCompleted = true;
        meta.slowBurnRecoveryPending = false;
        saveChatMeta();
        toastr.success(`"${targetProgress.target}" ${targetProgress.requiredTurns}회 진행을 채웠어요.`, '🫧또또sfw');
    }
    if (settings.armMode === 'stealth') maybeStealthArm();
    if (state?.heat !== null && state?.heat !== undefined && settings.armMode !== 'manual') {
        if (!meta.autoArmed && state.heat >= AUTO_ARM_ON) {
            meta.autoArmed = true;
            saveChatMeta();
            toastr.info(`장면 강도 ${state.heat}/10 — 연속성 개입을 시작해요.`, '🫧또또sfw');
            if (settings.autoRefine) {
                clearTimeout(refineTimer);
                refineTimer = setTimeout(() => { void runRefine(); }, 400);
            }
        } else if (meta.autoArmed && state.heat <= AUTO_ARM_OFF) {
            const prematureSlowBurnEnd = settings.slowBurnEnabled
                && meta.slowBurnSessionActive
                && !slowBurnProgress(settings).canConclude;
            if (prematureSlowBurnEnd) {
                const firstDetection = !meta.slowBurnRecoveryPending;
                meta.slowBurnRecoveryPending = true;
                meta.autoArmed = true;
                meta.bridgePending = false;
                saveChatMeta();
                if (firstDetection) toastr.warning('최소 턴 전에 장면 종료를 감지했어요. 개입을 유지해요.', '🫧또또sfw');
            } else {
                meta.autoArmed = false;
                meta.forceArmed = false;
                meta.bridgePending = Boolean(settings.exitBridge);
                resetSlowBurnSession(meta);
                if (settings.armMode === 'stealth') {
                    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
                    meta.stealthCooldownFrom = chat.length;
                }
                saveChatMeta();
                toastr.info(`장면 강도 ${state.heat}/10 — 개입을 해제하고 대기로 돌아가요.`, '🫧또또sfw');
            }
        } else if (state.heat > AUTO_ARM_OFF && meta.slowBurnRecoveryPending) {
            meta.slowBurnRecoveryPending = false;
            saveChatMeta();
        }
    }
    if (settings.armMode !== 'manual' && meta.autoArmed && !meta.forceArmed && stealthColdStreak()) {
        const prematureSlowBurnEnd = settings.slowBurnEnabled
            && meta.slowBurnSessionActive
            && !slowBurnProgress(settings).canConclude;
        if (prematureSlowBurnEnd) {
            meta.slowBurnRecoveryPending = true;
            meta.bridgePending = false;
            saveChatMeta();
        } else {
            meta.autoArmed = false;
            meta.bridgePending = Boolean(settings.exitBridge);
            resetSlowBurnSession(meta);
            const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
            meta.stealthCooldownFrom = chat.length;
            saveChatMeta();
            toastr.info(`장면 신호가 ${STEALTH_COLD_STREAK}턴째 없어요 — 개입을 해제해요.`, '🫧또또sfw');
        }
    }
    if (changed) {
        rerenderMessage(index, message);
        persistChat();
    }
    const completenessState = state ?? snapshotForMessage(message)?.state ?? null;
    const completenessIssues = found ? stateCompletenessIssues(completenessState, settings) : [];
    if (!found || completenessIssues.length) {
        scheduleAutoRefine();
    }
    updateUi();
}

// ───────────────────────── UI ─────────────────────────

function element(id) {
    return document.getElementById(id);
}

function setTab(tab) {
    document.querySelectorAll('#ttotto-sfw-settings [data-tns-tab]').forEach((button) => {
        const active = button.dataset.tnsTab === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    const panels = { state: element('tns-panel-state'), settings: element('tns-panel-settings') };
    for (const [name, panel] of Object.entries(panels)) {
        if (!panel) continue;
        const active = name === tab;
        panel.hidden = !active;
        if (active) panel.style.removeProperty('display');
        else panel.style.setProperty('display', 'none', 'important');
    }
}

function populateProfiles() {
    if (!uiReady) return;
    const select = element('tns-refine-profile');
    const settings = getSettings();
    const currentValue = String(settings.refineProfileId ?? '');
    select.replaceChildren();
    const current = document.createElement('option');
    current.value = '';
    current.textContent = '현재 연결 사용';
    select.append(current);
    try {
        const service = getContext().ConnectionManagerRequestService;
        const profiles = typeof service?.getSupportedProfiles === 'function' ? service.getSupportedProfiles() : [];
        for (const profile of profiles ?? []) {
            if (!profile?.id) continue;
            const option = document.createElement('option');
            option.value = String(profile.id);
            option.textContent = String(profile.name || profile.id);
            select.append(option);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} 연결 프로필 목록을 불러오지 못했습니다.`, error);
    }
    if (currentValue && ![...select.options].some((option) => option.value === currentValue)) {
        const missing = document.createElement('option');
        missing.value = currentValue;
        missing.textContent = '저장된 연결 프로필을 찾을 수 없음';
        select.append(missing);
    }
    select.value = currentValue;
}

function applyManualEdit(mutator) {
    const meta = getChatMeta();
    const { state } = effectiveState();
    const base = state ? structuredClone(state) : { location: '', characters: {}, acts: [] };
    mutator(base);
    meta.manualState = { state: sanitizeState(base) ?? base, at: Date.now(), source: 'manual' };
    saveChatMeta();
    updateUi();
}

function renderSlowBurnPanel(settings) {
    const card = element('tns-slow-burn-card');
    const developerMode = Boolean(settings.developerMode);
    card.hidden = !settings.slowBurnEnabled && !developerMode;
    if (card.hidden) return;

    const stageHead = card.querySelector('.tns-slow-burn-head');
    const stageControls = card.querySelector('.tns-slow-burn-controls');
    if (stageHead) stageHead.hidden = !settings.slowBurnEnabled;
    if (stageControls) stageControls.hidden = !settings.slowBurnEnabled;

    const progress = slowBurnProgress(settings);
    const targetProgress = progress.target;
    const targetInput = element('tns-slow-burn-target');
    const targetTurnsInput = element('tns-slow-burn-target-turns');
    element('tns-slow-burn-target-box').hidden = !developerMode;
    element('tns-slow-burn-target-note').hidden = !developerMode;
    if (document.activeElement !== targetInput) targetInput.value = targetProgress.target;
    if (document.activeElement !== targetTurnsInput) targetTurnsInput.value = String(targetProgress.requiredTurns);
    targetInput.disabled = targetProgress.active;
    targetTurnsInput.disabled = targetProgress.active;
    const targetBox = targetInput.closest('.tns-slow-burn-target-box');
    targetBox?.classList.toggle('is-active', targetProgress.active);
    element('tns-slow-burn-target-start').textContent = targetProgress.active ? '↻ 처음부터 다시' : '🎯 목표 시작';
    element('tns-slow-burn-target-stop').disabled = !targetProgress.active;
    element('tns-slow-burn-target-status').textContent = targetProgress.active
        ? `"${targetProgress.target}" · ${Math.min(targetProgress.completedTurns, targetProgress.requiredTurns)}/${targetProgress.requiredTurns}회 진행 중`
        : targetProgress.completed
            ? `"${targetProgress.target}" · ${targetProgress.requiredTurns}/${targetProgress.requiredTurns}회 완료`
            : targetProgress.target
                ? `"${targetProgress.target}"을(를) ${targetProgress.requiredTurns}회 진행할 준비가 됐어요.`
                : '장면과 횟수를 정하면 다음 AI 답변부터 정확히 그 횟수만큼 유지해요.';
    const stage = STORY_STAGES[progress.stage];
    const sourceLabel = {
        manual: '수동 선택',
        reported: 'AI 단계 감지',
        heat: '강도에서 감지',
        default: '초기 단계',
    }[progress.source] ?? '자동 감지';

    element('tns-slow-burn-stage').textContent = `${progress.stage}단계 · ${stage.ko}`;
    const sessionText = `활성화 후 ${Math.min(progress.sessionTurns, progress.requiredTurns)}/${progress.requiredTurns}턴`;
    const stageText = `현재 단계 ${Math.min(progress.turns, progress.requiredTurns)}/${progress.requiredTurns}턴`;
    element('tns-slow-burn-progress').textContent = progress.locked
        ? `${sessionText} · ${stageText} · 단계 고정 중`
        : progress.recoveryPending
            ? `${sessionText} · 조기 종료 감지, 장면 이어가기 대기`
            : `${sessionText} · ${stageText}`;
    element('tns-slow-burn-source').textContent = sourceLabel;
    element('tns-slow-burn-lock').textContent = progress.locked ? '🔓 고정 해제' : '🔒 단계 고정';
    element('tns-slow-burn-prev').disabled = progress.stage <= 1;
    element('tns-slow-burn-next').disabled = progress.stage >= 6;
    element('tns-slow-burn-auto').disabled = progress.source !== 'manual' && !progress.locked;
}

function renderCardLinkPanel(settings) {
    const box = element('tns-card-link-box');
    if (!box) return;
    box.hidden = !settings.cardLinkEnabled;
    element('tns-card-link').checked = Boolean(settings.cardLinkEnabled);
    if (!settings.cardLinkEnabled) return;

    const list = element('tns-card-link-list');
    const note = element('tns-card-link-note');
    list.replaceChildren();

    const { available, rows } = cardLinkOptions();
    if (!available) {
        note.textContent = 'CardInject 데이터를 찾지 못했어요.';
        return;
    }
    if (!rows.length) {
        note.textContent = '이 채팅 캐릭터에 저장된 CardInject 카테고리가 없어요.';
        return;
    }

    const selected = settings.cardLinkSelected ?? {};
    let duplicated = 0;
    let picked = 0;
    for (const row of rows) {
        const isSelected = Array.isArray(selected[row.charKey]) && selected[row.charKey].includes(row.catKey);
        if (isSelected) {
            picked++;
            if (row.ciEnabled) duplicated++;
        }
        const label = document.createElement('label');
        label.className = 'tns-setting-row tns-card-link-row';
        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = `${row.charName} · ${row.name}${row.likely ? ' ★' : ''}`;
        const meta = document.createElement('small');
        meta.textContent = `${row.content.length}자 · CardInject에서 ${row.ciEnabled ? '켜져 있음' : '꺼져 있음'}`;
        text.append(title, meta);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = isSelected;
        input.addEventListener('change', () => {
            const current = getSettings();
            const chosen = new Set(Array.isArray(current.cardLinkSelected[row.charKey]) ? current.cardLinkSelected[row.charKey] : []);
            if (input.checked) chosen.add(row.catKey);
            else chosen.delete(row.catKey);
            current.cardLinkSelected[row.charKey] = [...chosen];
            saveSettings();
            updateUi();
        });
        label.append(text, input);
        list.append(label);
    }
    note.textContent = duplicated
        ? `⚠️ 고른 ${picked}개 중 ${duplicated}개가 CardInject에서도 켜져 있어요. (★ = 성향·특성 관련처럼 보이는 카테고리)`
        : `고른 ${picked}개는 개입 중일 때만 주입돼요. (★ = 성향·특성 관련처럼 보이는 카테고리)`;
}

function renderStatePanel() {
    const { state, source } = effectiveState();
    const settings = getSettings();
    renderSlowBurnPanel(settings);
    renderCardLinkPanel(settings);
    const sourceLabel = { tag: '응답 태그에서 추적됨', 'ai-refine': '보조 AI 보정 결과', manual: '수동 수정됨', none: '아직 기록 없음' }[source] ?? source;
    element('tns-state-source').textContent = refineRunning ? '보조 AI 분석 중…' : sourceLabel;

    const heatBadge = element('tns-heat');
    if (state?.heat !== null && state?.heat !== undefined) {
        heatBadge.hidden = false;
        heatBadge.textContent = `⚡ ${state.heat}/10`;
        heatBadge.classList.toggle('is-hot', state.heat >= AUTO_ARM_ON);
    } else {
        heatBadge.hidden = true;
    }

    const locationInput = element('tns-state-location');
    if (document.activeElement !== locationInput) locationInput.value = biText(state?.location);

    const list = element('tns-char-list');
    list.replaceChildren();
    const characters = state?.characters ?? {};
    for (const [name, info] of Object.entries(characters)) {
        const row = document.createElement('div');
        row.className = 'tns-char-row';
        const title = document.createElement('strong');
        title.textContent = name;
        row.append(title);
        for (const [field, label] of [['clothing', '외모·복장'], ['position', '자세·위치'], ['contact', '상호작용']]) {
            const wrap = document.createElement('label');
            wrap.className = 'tns-char-field';
            const caption = document.createElement('span');
            caption.textContent = label;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'text_pole';
            input.value = biText(info[field]);
            input.addEventListener('change', () => {
                applyManualEdit((draft) => {
                    if (!draft.characters[name]) draft.characters[name] = { clothing: '', position: '', contact: '' };
                    draft.characters[name][field] = input.value;
                });
            });
            wrap.append(caption, input);
            row.append(wrap);
        }
        list.append(row);
    }
    element('tns-char-empty').hidden = Object.keys(characters).length > 0;

    const actsList = element('tns-acts-list');
    actsList.replaceChildren();
    const rows = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow);
    for (const row of rows) {
        for (const act of row.acts) {
            const chip = document.createElement('span');
            chip.className = 'tns-act-chip';
            const text = document.createElement('span');
            text.textContent = biText(act);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = '이 항목은 반복 금지에서 제외';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                const meta = getChatMeta();
                for (const key of [biText(act, 'en'), biText(act, 'ko')]) {
                    if (key && !meta.ignoredActs.includes(key)) meta.ignoredActs.push(key);
                }
                saveChatMeta();
                updateUi();
            });
            chip.append(text, remove);
            actsList.append(chip);
        }
    }
    element('tns-acts-empty').hidden = rows.length > 0;
    element('tns-acts-summary').textContent = `최근 ${settings.repeatWindow}턴 기준`;

    const dialogueSection = element('tns-dialogue-section');
    const dialogueEnabled = Boolean(settings.dialogueBeatGuard);
    const dialogueSummary = element('tns-dialogue-summary');
    if (dialogueSummary) dialogueSummary.textContent = `최근 ${settings.dialogueWindow}개의 AI 답변에서 이미 사용한 대사의 목적이에요.`;
    dialogueSection.hidden = !dialogueEnabled;
    const dialogueList = element('tns-dialogue-list');
    dialogueList.replaceChildren();
    const dialogueRows = dialogueEnabled ? recentDialogueBeats() : [];
    for (const row of dialogueRows) {
        for (const beat of row.beats) {
            const chip = document.createElement('span');
            chip.className = 'tns-act-chip';
            const text = document.createElement('span');
            text.textContent = biText(beat);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = '이 대사 의도는 반복 금지에서 제외';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                const meta = getChatMeta();
                for (const key of [biText(beat, 'en'), biText(beat, 'ko')]) {
                    if (key && !meta.ignoredDialogueBeats.includes(key)) meta.ignoredDialogueBeats.push(key);
                }
                saveChatMeta();
                updateUi();
            });
            chip.append(text, remove);
            dialogueList.append(chip);
        }
    }
    element('tns-dialogue-empty').hidden = dialogueRows.length > 0;

    const nextList = element('tns-next-list');
    nextList.replaceChildren();
    const targetActive = slowBurnTargetProgress().active;
    const beats = settings.nextBeatHints && !targetActive ? nextBeatCandidates() : [];
    for (const beat of beats) {
        const chip = document.createElement('span');
        chip.className = 'tns-act-chip tns-next-chip';
        const text = document.createElement('span');
        text.textContent = biText(beat);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = '이 후보는 제안에서 제외';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const meta = getChatMeta();
            for (const key of [biText(beat, 'en'), biText(beat, 'ko')]) {
                if (key && !meta.ignoredActs.includes(key)) meta.ignoredActs.push(key);
            }
            saveChatMeta();
            updateUi();
        });
        chip.append(text, remove);
        nextList.append(chip);
    }
    const nextSection = element('tns-next-section');
    nextSection.hidden = !settings.nextBeatHints || targetActive;
    element('tns-next-empty').hidden = !settings.nextBeatHints || targetActive || beats.length > 0;

    const customList = element('tns-custom-ban-list');
    customList.replaceChildren();
    const meta = getChatMeta(false);
    for (const ban of meta?.customBans ?? []) {
        const chip = document.createElement('span');
        chip.className = 'tns-act-chip tns-custom-chip';
        const text = document.createElement('span');
        text.textContent = ban;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = '금지 해제';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const chatMeta = getChatMeta();
            chatMeta.customBans = chatMeta.customBans.filter((item) => item !== ban);
            saveChatMeta();
            updateUi();
        });
        chip.append(text, remove);
        customList.append(chip);
    }

    const globalList = element('tns-global-ban-list');
    globalList.replaceChildren();
    for (const ban of settings.globalBans ?? []) {
        const chip = document.createElement('span');
        chip.className = 'tns-act-chip tns-custom-chip';
        const text = document.createElement('span');
        text.textContent = ban;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = '하드 리밋 해제';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const current = getSettings();
            current.globalBans = (current.globalBans ?? []).filter((item) => item !== ban);
            saveSettings();
            updateUi();
        });
        chip.append(text, remove);
        globalList.append(chip);
    }

    const scoreBox = element('tns-score-box');
    if (settings.armMode === 'stealth' && isSupervising()) {
        scoreBox.hidden = false;
        const { score, hits } = stealthWindowDetail();
        const threshold = STEALTH_THRESHOLDS[settings.stealthSensitivity] ?? STEALTH_THRESHOLDS.normal;
        element('tns-score-value').textContent = `${score} / 기준 ${threshold}`;
        const hitsList = element('tns-score-hits');
        hitsList.replaceChildren();
        const seenHits = new Set();
        for (const hit of hits) {
            const key = `${hit.label}:${hit.text.toLocaleLowerCase()}`;
            if (seenHits.has(key)) continue;
            seenHits.add(key);
            if (seenHits.size > 12) break;
            const chip = document.createElement('span');
            chip.className = 'tns-act-chip tns-hit-chip';
            chip.textContent = `${hit.text} (${hit.label} +${hit.w})`;
            hitsList.append(chip);
        }
        element('tns-score-note').hidden = hits.length > 0;
    } else {
        scoreBox.hidden = true;
    }
}

let promptTokenSeq = 0;
let promptTokenCache = { text: null, label: '' };

function estimateTokens(text) {
    let ascii = 0;
    let other = 0;
    for (const char of String(text ?? '')) {
        if (char.charCodeAt(0) < 128) ascii++;
        else other++;
    }
    return Math.ceil(ascii / 4 + other * 1.5);
}

async function countPromptTokens(text) {
    const context = getContext();
    const counter = context.getTokenCountAsync ?? context.getTokenCount;
    if (typeof counter === 'function') {
        try {
            const value = Number(await counter.call(context, text));
            if (Number.isFinite(value) && value >= 0) return { count: Math.round(value), exact: true };
        } catch (error) {
            console.debug(`${LOG_PREFIX} 토큰 계산 실패 — 대략치로 표시`, error);
        }
    }
    return { count: estimateTokens(text), exact: false };
}

function refreshPromptSize(prompt) {
    const sizeElement = element('tns-prompt-size');
    if (!sizeElement) return;
    const chars = String(prompt ?? '').length;
    if (!chars) {
        promptTokenSeq++;
        sizeElement.textContent = '0자 · 0토큰';
        return;
    }
    const charLabel = `${chars.toLocaleString()}자`;
    if (promptTokenCache.text === prompt) {
        sizeElement.textContent = `${charLabel} · ${promptTokenCache.label}`;
        return;
    }
    sizeElement.textContent = `${charLabel} · 약 ${estimateTokens(prompt).toLocaleString()}토큰`;
    const seq = ++promptTokenSeq;
    void countPromptTokens(prompt).then(({ count, exact }) => {
        if (seq !== promptTokenSeq) return;
        const label = `${exact ? '' : '약 '}${count.toLocaleString()}토큰`;
        promptTokenCache = { text: prompt, label };
        const current = element('tns-prompt-size');
        if (current) current.textContent = `${charLabel} · ${label}`;
    });
}

function updateUi() {
    if (!uiReady) return;
    try {
        const settings = getSettings();
        const meta = getChatMeta(false);

        const popupDeveloperTitle = element('tns-popup-developer-title');
        if (popupDeveloperTitle) {
            popupDeveloperTitle.textContent = settings.developerMode ? '✨ 또또SFW 🧪' : '✨ 또또SFW';
        }

        element('tns-enabled').checked = Boolean(settings.enabled);
        element('tns-chat-enabled').checked = Boolean(meta?.enabled);
        element('tns-repeat-window').value = String(settings.repeatWindow);
        element('tns-repeat-window-value').textContent = `${settings.repeatWindow}턴`;
        element('tns-max-banned').value = String(settings.maxBannedActs);
        element('tns-max-banned-value').textContent = `${settings.maxBannedActs}개`;
        element('tns-pace-mode').value = String(settings.paceMode);
        element('tns-pace-mode').disabled = Boolean(settings.slowBurnEnabled);
        element('tns-pace-mode-note').textContent = settings.slowBurnEnabled
            ? '스토리 페이싱이 켜져 있어 현재는 단계별 진행 제한이 대신 적용돼요.'
            : '스토리 페이싱을 켜면 이 설정 대신 단계별 진행 제한이 적용돼요.';
        element('tns-slow-burn-enabled').checked = Boolean(settings.slowBurnEnabled);
        element('tns-slow-burn-intensity').value = String(settings.slowBurnIntensity);
        element('tns-slow-burn-intensity').disabled = !settings.slowBurnEnabled;
        element('tns-slow-burn-user-override').checked = Boolean(settings.slowBurnUserOverride);
        element('tns-slow-burn-user-override').disabled = !settings.slowBurnEnabled;
        element('tns-style-length').value = String(settings.styleLength);
        element('tns-style-balance').value = String(settings.styleBalance);
        element('tns-exit-bridge').checked = Boolean(settings.exitBridge);
        element('tns-arm-mode').value = String(settings.armMode);
        element('tns-stealth-sensitivity').value = String(settings.stealthSensitivity);
        const keywordsInput = element('tns-stealth-keywords');
        if (document.activeElement !== keywordsInput) keywordsInput.value = String(settings.stealthKeywords ?? '');
        element('tns-next-hints').checked = Boolean(settings.nextBeatHints);
        element('tns-dialogue-guard').checked = Boolean(settings.dialogueBeatGuard);
        element('tns-dialogue-window').value = String(settings.dialogueWindow);
        element('tns-dialogue-window').disabled = !settings.dialogueBeatGuard;
        element('tns-dialogue-window-value').textContent = `${settings.dialogueWindow}개`;
        element('tns-auto-refine').checked = Boolean(settings.autoRefine);

        const armed = isSupervising();
        const heat = effectiveState().state?.heat;
        const heatText = heat !== null && heat !== undefined ? ` (강도 ${heat}/10)` : '';
        element('tns-header-status').textContent = !settings.enabled
            ? '꺼져 있어요'
            : !meta?.enabled
                ? '이 채팅에서는 쉬는 중'
                : refineRunning
                    ? '보조 AI 분석 중…'
                    : settings.armMode === 'stealth'
                        ? (meta?.autoArmed ? `개입 중이에요${heatText}` : '조용히 대기 중이에요 (주입 없음)')
                        : settings.armMode === 'auto'
                            ? (meta?.autoArmed ? `개입 중이에요${heatText}` : `장면을 감시하는 중이에요${heatText}`)
                            : '장면을 지켜보는 중이에요';

        element('tns-refine').disabled = refineRunning;
        element('tns-force-arm-label').textContent = isFullyArmed() ? '개입 해제' : '지금 개입';
        renderStatePanel();

        const preview = element('tns-prompt-preview');
        if (!preview.hidden) {
            const prompt = armed ? buildInjection() : '';
            element('tns-prompt-text').textContent = prompt || '(지금은 주입할 내용이 없어요)';
            refreshPromptSize(prompt);
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} UI 갱신 실패`, error);
    }
}

function bindSetting(id, key, parser = (value) => value, after = null) {
    element(id).addEventListener('change', () => {
        const target = element(id);
        const value = target.type === 'checkbox' ? target.checked : target.value;
        const settings = getSettings();
        settings[key] = parser(value);
        saveSettings();
        if (!settings.enabled) clearInjectedPrompt();
        if (typeof after === 'function') after(settings);
        updateUi();
    });
}

function bindUi() {
    const root = document.getElementById('ttotto-sfw-settings');
    element('tns-developer-title').addEventListener('click', handleDeveloperTitleTap);
    root.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-tns-tab]');
        if (button && root.contains(button)) {
            event.preventDefault();
            event.stopPropagation();
            setTab(button.dataset.tnsTab);
        }
    });

    const syncSlowBurnSession = (settings) => {
        const meta = getChatMeta(false);
        if (!meta) return;
        resetSlowBurnSession(meta);
        saveChatMeta();
        if (settings.enabled && settings.slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
    };
    bindSetting('tns-enabled', 'enabled', Boolean, syncSlowBurnSession);
    bindSetting('tns-arm-mode', 'armMode', String, (settings) => {
        if (settings.armMode === 'manual') {
            const meta = getChatMeta(false);
            if (meta) {
                meta.autoArmed = false;
                resetSlowBurnSession(meta);
                saveChatMeta();
            }
        }
    });
    bindSetting('tns-stealth-sensitivity', 'stealthSensitivity', String);
    bindSetting('tns-stealth-keywords', 'stealthKeywords', String);
    bindSetting('tns-next-hints', 'nextBeatHints', Boolean);
    bindSetting('tns-dialogue-guard', 'dialogueBeatGuard', Boolean);
    bindSetting('tns-card-link', 'cardLinkEnabled', Boolean);
    element('tns-card-link-refresh').addEventListener('click', () => {
        updateUi();
        toastr.info('CardInject 카테고리 목록을 다시 읽었어요.', '🫧또또sfw');
    });
    const dialogueSlider = element('tns-dialogue-window');
    dialogueSlider.addEventListener('input', () => {
        element('tns-dialogue-window-value').textContent = `${dialogueSlider.value}개`;
    });
    dialogueSlider.addEventListener('change', () => {
        const settings = getSettings();
        settings.dialogueWindow = Math.min(6, Math.max(1, Number(dialogueSlider.value) || DIALOGUE_BEAT_WINDOW));
        saveSettings();
        updateUi();
    });
    bindSetting('tns-pace-mode', 'paceMode', String);
    bindSetting('tns-slow-burn-enabled', 'slowBurnEnabled', Boolean, (settings) => {
        const meta = getChatMeta(false);
        if (!meta) return;
        resetSlowBurnSession(meta);
        saveChatMeta();
        if (settings.slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
    });
    bindSetting('tns-slow-burn-intensity', 'slowBurnIntensity', String);
    bindSetting('tns-slow-burn-user-override', 'slowBurnUserOverride', Boolean);
    bindSetting('tns-style-length', 'styleLength', String);
    bindSetting('tns-style-balance', 'styleBalance', String);
    bindSetting('tns-exit-bridge', 'exitBridge', Boolean);
    bindSetting('tns-auto-refine', 'autoRefine', Boolean);
    bindSetting('tns-refine-profile', 'refineProfileId', String);

    const slider = element('tns-repeat-window');
    slider.addEventListener('input', () => {
        element('tns-repeat-window-value').textContent = `${slider.value}턴`;
    });
    slider.addEventListener('change', () => {
        const settings = getSettings();
        settings.repeatWindow = Math.min(10, Math.max(1, Number(slider.value) || DEFAULT_SETTINGS.repeatWindow));
        saveSettings();
        updateUi();
    });

    const maxBannedSlider = element('tns-max-banned');
    maxBannedSlider.addEventListener('input', () => {
        element('tns-max-banned-value').textContent = `${maxBannedSlider.value}개`;
    });
    maxBannedSlider.addEventListener('change', () => {
        const settings = getSettings();
        settings.maxBannedActs = Math.min(30, Math.max(5, Number(maxBannedSlider.value) || DEFAULT_SETTINGS.maxBannedActs));
        saveSettings();
        updateUi();
    });

    element('tns-chat-enabled').addEventListener('change', () => {
        const meta = getChatMeta();
        const wasEnabled = Boolean(meta.enabled);
        meta.enabled = element('tns-chat-enabled').checked;
        if (wasEnabled && !meta.enabled) {
            meta.bridgePending = Boolean(getSettings().exitBridge);
            meta.autoArmed = false;
            meta.forceArmed = false;
            const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
            meta.stealthCooldownFrom = chat.length;
        } else if (meta.enabled) {
            meta.bridgePending = false;
        }
        resetSlowBurnSession(meta);
        saveChatMeta();
        if (!meta.enabled) clearInjectedPrompt();
        else if (getSettings().slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
        updateUi();
    });

    element('tns-state-location').addEventListener('change', () => {
        applyManualEdit((draft) => { draft.location = element('tns-state-location').value; });
    });

    element('tns-refine').addEventListener('click', () => { void runRefine({ manual: true }); });
    element('tns-force-arm').addEventListener('click', forceToggleArm);

    const saveSlowBurnTargetDraft = () => {
        if (!getSettings().developerMode) return;
        const meta = getChatMeta();
        meta.slowBurnTarget = sanitizeSlowBurnTarget(element('tns-slow-burn-target').value);
        meta.slowBurnTargetTurns = clampSlowBurnTargetTurns(element('tns-slow-burn-target-turns').value);
        meta.slowBurnTargetCompleted = false;
        saveChatMeta();
        updateUi();
    };
    element('tns-slow-burn-target').addEventListener('change', saveSlowBurnTargetDraft);
    element('tns-slow-burn-target-turns').addEventListener('change', saveSlowBurnTargetDraft);
    element('tns-slow-burn-target').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            element('tns-slow-burn-target-start').click();
        }
    });
    element('tns-slow-burn-target-start').addEventListener('click', () => {
        const settings = getSettings();
        if (!settings.developerMode) return;
        const target = sanitizeSlowBurnTarget(element('tns-slow-burn-target').value);
        const turns = clampSlowBurnTargetTurns(element('tns-slow-burn-target-turns').value);
        if (!target) {
            toastr.warning('보고 싶은 장면을 먼저 입력해주세요.', '🫧또또sfw');
            element('tns-slow-burn-target').focus();
            return;
        }
        if (!settings.enabled) {
            toastr.warning('전체 사용을 먼저 켜주세요.', '🫧또또sfw');
            return;
        }
        if (!settings.slowBurnEnabled) {
            settings.slowBurnEnabled = true;
            saveSettings();
        }
        const meta = getChatMeta();
        resetSlowBurnSession(meta);
        meta.enabled = true;
        meta.bridgePending = false;
        meta.slowBurnTarget = target;
        meta.slowBurnTargetTurns = turns;
        meta.slowBurnTargetActive = true;
        meta.slowBurnTargetCompleted = false;
        if (settings.armMode !== 'manual') {
            meta.autoArmed = true;
            meta.forceArmed = true;
        }
        saveChatMeta();
        startSlowBurnSessionIfNeeded();
        toastr.success(`"${target}" 장면을 다음 AI 답변부터 ${turns}회 유지해요.`, '🫧또또sfw');
        updateUi();
    });
    element('tns-slow-burn-target-stop').addEventListener('click', () => {
        if (!getSettings().developerMode) return;
        const meta = getChatMeta();
        meta.slowBurnTargetActive = false;
        meta.slowBurnTargetCompleted = false;
        meta.slowBurnRecoveryPending = false;
        saveChatMeta();
        toastr.info('목표 장면 진행을 중지했어요.', '🫧또또sfw');
        updateUi();
    });

    const setSlowBurnStage = (offset) => {
        const meta = getChatMeta();
        const current = slowBurnStageInfo().stage;
        meta.slowBurnStageOverride = Math.max(1, Math.min(6, current + offset));
        saveChatMeta();
        updateUi();
    };
    element('tns-slow-burn-prev').addEventListener('click', () => setSlowBurnStage(-1));
    element('tns-slow-burn-next').addEventListener('click', () => setSlowBurnStage(1));
    element('tns-slow-burn-lock').addEventListener('click', () => {
        const meta = getChatMeta();
        if (meta.slowBurnLocked) {
            meta.slowBurnLocked = false;
            meta.slowBurnStageOverride = null;
        } else {
            meta.slowBurnStageOverride = slowBurnStageInfo().stage;
            meta.slowBurnLocked = true;
        }
        saveChatMeta();
        updateUi();
    });
    element('tns-slow-burn-auto').addEventListener('click', () => {
        const meta = getChatMeta();
        meta.slowBurnStageOverride = null;
        meta.slowBurnLocked = false;
        resetSlowBurnSession(meta);
        saveChatMeta();
        updateUi();
    });

    const addGlobalBan = () => {
        const input = element('tns-global-ban-input');
        const value = input.value.trim();
        if (!value) return;
        const settings = getSettings();
        if (!Array.isArray(settings.globalBans)) settings.globalBans = [];
        if (!settings.globalBans.includes(value)) settings.globalBans.push(value);
        input.value = '';
        saveSettings();
        updateUi();
    };
    element('tns-global-ban-add').addEventListener('click', addGlobalBan);
    element('tns-global-ban-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addGlobalBan(); }
    });

    const addCustomBan = () => {
        const input = element('tns-custom-ban-input');
        const value = input.value.trim();
        if (!value) return;
        const meta = getChatMeta();
        if (!meta.customBans.includes(value)) meta.customBans.push(value);
        input.value = '';
        saveChatMeta();
        updateUi();
    };
    element('tns-custom-ban-add').addEventListener('click', addCustomBan);
    element('tns-custom-ban-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addCustomBan(); }
    });

    element('tns-clear-state').addEventListener('click', () => {
        const meta = getChatMeta();
        meta.manualState = null;
        meta.ignoredActs = [];
        meta.ignoredDialogueBeats = [];
        meta.slowBurnStageOverride = null;
        meta.slowBurnLocked = false;
        for (const message of assistantMessages()) {
            const store = getMessageStore(message, false);
            if (store) delete message.extra[MESSAGE_EXTRA_KEY];
        }
        saveChatMeta();
        persistChat();
        toastr.info('이 채팅의 장면 기록을 비웠어요.', '🫧또또sfw');
        updateUi();
    });

    element('tns-toggle-preview').addEventListener('click', () => {
        const preview = element('tns-prompt-preview');
        preview.hidden = !preview.hidden;
        element('tns-toggle-preview').textContent = preview.hidden ? '주입문 보기' : '주입문 접기';
        updateUi();
    });
}

// ───────────────────────── 팝업 ─────────────────────────

function buildPopupShell() {
    if (document.getElementById('tns-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'tns-overlay';
    overlay.className = 'tns-overlay';
    overlay.innerHTML = [
        '<div class="tns-popup">',
        '  <div class="tns-popup-header">',
        '    <strong id="tns-popup-developer-title">✨ 또또SFW</strong>',
        '    <button id="tns-popup-close" class="menu_button" type="button" title="닫기">✕</button>',
        '  </div>',
        '  <div id="tns-popup-body" class="tns-popup-body"></div>',
        '</div>',
    ].join('\n');
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closePopup();
    });
    overlay.querySelector('#tns-popup-close').addEventListener('click', closePopup);
    overlay.querySelector('#tns-popup-developer-title').addEventListener('click', handleDeveloperTitleTap);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && popupOpen) closePopup();
    });
}

function openPopup() {
    if (!uiReady) {
        toastr.warning('설정 패널이 아직 준비되지 않았어요. 잠시 후 다시 열어주세요.', '🫧또또sfw');
        return;
    }
    buildPopupShell();
    const panel = document.getElementById('ttotto-sfw-settings');
    const overlay = document.getElementById('tns-overlay');
    if (!panel || !overlay) return;
    if (!settingsHomeParent) settingsHomeParent = panel.parentElement;
    document.getElementById('tns-popup-body').append(panel);
    panel.classList.add('tns-in-popup');
    const drawerContent = panel.querySelector('.inline-drawer-content');
    if (drawerContent) drawerContent.style.setProperty('display', 'block', 'important');
    overlay.classList.add('open');
    popupOpen = true;
    updateUi();
}

function closePopup() {
    const overlay = document.getElementById('tns-overlay');
    const panel = document.getElementById('ttotto-sfw-settings');
    overlay?.classList.remove('open');
    if (panel && settingsHomeParent) {
        panel.classList.remove('tns-in-popup');
        const drawerContent = panel.querySelector('.inline-drawer-content');
        if (drawerContent) drawerContent.style.removeProperty('display');
        settingsHomeParent.append(panel);
    }
    popupOpen = false;
}

function addWandButton() {
    if (document.getElementById('tns-wand-button')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = 'tns-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<span class="extensionsMenuExtensionButton" aria-hidden="true">✨</span><span>또또SFW</span>';
    item.addEventListener('click', () => {
        menu.style.display = 'none';
        openPopup();
    });
    menu.append(item);
}

function removeWandButton() {
    document.getElementById('tns-wand-button')?.remove();
}

async function loadSettingsHtml() {
    const response = await fetch(new URL('settings.html', EXTENSION_BASE_URL));
    if (!response.ok) throw new Error(`settings.html 로드 실패 (HTTP ${response.status})`);
    return response.text();
}

async function initializeUi() {
    if (document.getElementById('ttotto-sfw-settings')) return;
    const html = await loadSettingsHtml();
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) throw new Error('확장 설정 컨테이너를 찾을 수 없습니다.');
    container.insertAdjacentHTML('beforeend', html);
    const required = [
        'tns-enabled',
        'tns-chat-enabled',
        'tns-repeat-window',
        'tns-pace-mode',
        'tns-slow-burn-enabled',
        'tns-slow-burn-stage',
        'tns-refine',
        'tns-state-location',
        'tns-dialogue-window',
        'tns-card-link',
        'tns-card-link-list',
    ];
    const missing = required.filter((id) => !document.getElementById(id));
    if (missing.length) throw new Error(`설정 패널 요소 누락: ${missing.join(', ')}`);
    uiReady = true;
    bindUi();
    populateProfiles();
    setTab('state');
    addWandButton();
    updateUi();
}

// ───────────────────────── 이벤트 등록/수명주기 ─────────────────────────

function registerEvents() {
    if (eventsRegistered) return;
    const context = getContext();
    const events = getEventTypes(context);
    const listen = (name, handler) => {
        const event = events[name];
        if (!event) return;
        context.eventSource.on(event, handler);
        registeredEventHandlers.push({ event, handler });
    };

    listen('MESSAGE_RECEIVED', (index) => handleIncomingMessage(index));
    listen('GENERATION_ENDED', () => handleIncomingMessage());
    listen('MESSAGE_SWIPED', (index) => handleIncomingMessage(index));
    listen('MESSAGE_EDITED', () => updateUi());
    listen('MESSAGE_DELETED', () => updateUi());
    listen('CHAT_CHANGED', () => {
        clearTimeout(refineTimer);
        refineAbortController?.abort();
        clearInjectedPrompt();
        populateProfiles();
        updateUi();
    });
    listen('CHAT_CREATED', () => updateUi());
    listen('CONNECTION_PROFILE_LOADED', populateProfiles);
    eventsRegistered = true;
}

function unregisterEvents() {
    if (!eventsRegistered) return;
    const eventSource = getContext().eventSource;
    for (const { event, handler } of registeredEventHandlers.splice(0)) {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(event, handler);
        else if (typeof eventSource.off === 'function') eventSource.off(event, handler);
    }
    eventsRegistered = false;
}

async function initialize() {
    runtimeActive = true;
    getSettings();
    registerEvents();
    await initializeUi();
    console.log(`${LOG_PREFIX} v${EXTENSION_VERSION} 로드 완료`);
}

export function onEnable() {
    runtimeActive = true;
    registerEvents();
    if (uiReady) addWandButton();
    updateUi();
}

export function onDisable() {
    runtimeActive = false;
    clearTimeout(refineTimer);
    refineAbortController?.abort();
    closePopup();
    removeWandButton();
    unregisterEvents();
    const meta = getChatMeta(false);
    if (meta) {
        resetSlowBurnSession(meta);
        saveChatMeta();
    }
    clearInjectedPrompt();
}

export function onClean() {
    closePopup();
    removeWandButton();
    document.getElementById('tns-overlay')?.remove();
    const context = getContext();
    delete context.extensionSettings[MODULE_NAME];
    if (context.chatMetadata && typeof context.chatMetadata === 'object') {
        delete context.chatMetadata[CHAT_STATE_KEY];
        saveChatMeta();
    }
    context.saveSettingsDebounced();
    clearInjectedPrompt();
}

const bootContext = getContext();
const bootEvents = getEventTypes(bootContext);
if (bootEvents.APP_READY) {
    bootContext.eventSource.on(bootEvents.APP_READY, () => {
        if (!runtimeActive) return;
        void initialize().catch((error) => {
            console.error(`${LOG_PREFIX} 초기화 실패`, error);
            toastr.error(`초기화 실패: ${error?.message ?? error}`, '🫧또또sfw');
        });
    });
} else {
    void initialize().catch((error) => console.error(`${LOG_PREFIX} 초기화 실패`, error));
}
