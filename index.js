// 🫧또또SFW — 일반(전연령) 장면 연속성 추적 + 직전 전개 반복 금지 + 진도 관리
// 또또(ttotto)/또또NSFW의 자매 확장. NSFW판과 동시에 설치해도 충돌하지 않도록 저장 키·태그·DOM 프리픽스를 전부 분리했다.
// 정적 import 없이 getContext() 기반으로 동작.
//
// 동작 개요 (하이브리드):
//  1) 매 생성마다 프롬프트에 "현재 장면 상태 + 최근 N턴 전개(반복 금지) + 상태 태그 갱신 지시"를 주입
//  2) AI 응답 끝의 <sfw_scene>{...}</sfw_scene> 태그를 파싱해 메시지 extra에 저장하고 본문에서 제거
//  3) 태그가 누락되면(또는 수동 버튼) 보조 AI 호출로 최근 대화를 분석해 상태를 보정

const MODULE_NAME = 'ttotto-sfw';
// 설치된 폴더 이름이 무엇이든 동작하도록, 템플릿은 모듈 URL 기준으로 직접 불러온다.
const EXTENSION_BASE_URL = new URL('.', import.meta.url);
const PROMPT_KEY = 'ttotto_sfw_continuity';
const CHAT_STATE_KEY = 'ttottoSfw';
const MESSAGE_EXTRA_KEY = 'ttottoSfw';
const LOG_PREFIX = '[🫧또또SFW]';
const EXTENSION_VERSION = '0.1.0';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
// setExtensionPrompt 안정 상수: IN_CHAT = 1, SYSTEM = 0 (또또와 동일한 이유로 직접 import 회피)
const PROMPT_POSITION_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;

const STATE_TAG_REGEX = /<sfw_scene\b[^>]*>([\s\S]*?)<\/sfw_scene>/gi;
const STATE_TAG_LOOSE_REGEX = /```(?:json)?\s*<sfw_scene\b[^>]*>[\s\S]*?<\/sfw_scene>\s*```/gi;
// 모델이 상태 태그를 닫은 직후 덧붙인 단독 확인 문구만 제거한다.
// 태그 앞의 본문이나 태그 뒤에 다른 서술이 하나라도 있으면 일치하지 않는다.
const STATE_TRAILING_ACK_REGEX = /(<\/sfw_scene>[ \t]*(?:\r?\n[ \t]*```)?)[ \t\r\n]+(?:no\s+changes?|unchanged)[ \t]*[.!]?[ \t]*$/i;

const PACE_INSTRUCTIONS = Object.freeze({
    hold: 'Maintain the current stage of the scene. Deepen sensation and reaction without jumping ahead.',
    slow: 'Move the scene forward to its next natural beat. Advance gradually — one meaningful step per response.',
    push: 'Actively escalate. Each response must clearly progress the scene beyond where the previous one ended.',
});

// 슬로우번 단계 — 특정 행위가 아니라 장면의 서사적 진행도를 추적한다. 로맨스든 갈등이든 어떤 아크에도 쓸 수 있게 일반화.
const SLOW_BURN_STAGES = Object.freeze([
    null,
    { en: 'Tension and atmosphere', ko: '긴장과 분위기 형성' },
    { en: 'Approach through gaze, words, and proximity', ko: '시선·말·거리 좁히기' },
    { en: 'First meaningful exchange or contact', ko: '첫 의미 있는 교류·접촉' },
    { en: 'Deepening connection and reactions', ko: '관계와 반응 심화' },
    { en: 'Turning point or decisive escalation', ko: '전환점·고조' },
    { en: 'Resolution or conclusion permitted', ko: '해소·결말 허용' },
]);

const SLOW_BURN_MIN_TURNS = Object.freeze({
    gentle: 1,
    slow: 2,
    verySlow: 3,
});
const SLOW_BURN_TARGET_MAX_TURNS = 20;
const SLOW_BURN_TARGET_MAX_LENGTH = 200;
const DIALOGUE_BEAT_WINDOW = 2;

// 장면 스타일 다이얼 — 무장 중에만 적용
const STYLE_LENGTH_INSTRUCTIONS = Object.freeze({
    tight: 'Length: keep the response tight — 2-3 short paragraphs. Every sentence must carry sensation, action, or reaction; cut filler narration. Leave room for the user to act.',
    normal: '',
    long: 'Length: write a full, unhurried response — take space to build each moment. Do not rush through beats; linger where it matters.',
});
const STYLE_BALANCE_INSTRUCTIONS = Object.freeze({
    dialogue: 'Balance: dialogue-forward. The character keeps talking through the scene — teasing, reacting, murmuring, demanding. Physical description supports the dialogue, not the other way around.',
    balanced: '',
    sensory: 'Balance: sensory-forward. Prioritize concrete physical sensation — touch, heat, breath, weight, sound. Keep dialogue sparse and purposeful.',
    internal: 'Balance: interiority-forward. Keep the character\'s inner voice present — thoughts, restraint, want, conflict — woven through the physical action.',
});

// 해제 브릿지 — 개입 해제 직후 딱 한 번, 장면을 자연스럽게 마무리시키는 지시
const BRIDGE_LINES = [
    '[Scene Wind-Down] The intimate scene has just concluded. This response is the wind-down: settle the afterglow naturally — calming breath, small gestures, quiet words, gentle humor if it fits the characters.',
    'Reflect what just happened in the characters\' mood and closeness. Do not restart or escalate the scene, and do not jump abruptly to unrelated everyday narration.',
];

// 실질적 무제한 — 잘림 방지용 안전 상한만 백만으로 걸어둔다
const SAFETY_LIMIT = 1000000;

// 강도 자동 무장 히스테리시스: 이 강도 이상이면 개입 시작, 이 강도 이하면 해제
const AUTO_ARM_ON = 5;
const AUTO_ARM_OFF = 2;

const REFINE_MESSAGE_CHAR_LIMIT = 12000;
const REFINE_TOTAL_CHAR_LIMIT = 60000;

const INTENSITY_SCALE_LINES = Object.freeze([
    'INTENSITY SCALE (judge the scene facts at the END of the response, not isolated words or discussion):',
    '- 0-1: ordinary, everyday scene; 2: mild tension, charm, or emotional charge without sustained conflict or closeness.',
    '- 3-4: clearly rising tension, meaningful closeness, or an emotional turn worth tracking closely.',
    '- 5-6: a confrontation, emotional peak, or pivotal moment is unmistakably underway; this is the active-supervision threshold.',
    '- 7-8: the scene\'s climax is actively unfolding or intensifying; 9: a decisive turn is imminent; 10: peak moment or the scene is about to conclude.',
]);

const DEFAULT_SETTINGS = Object.freeze({
    settingsSchemaVersion: 2,
    enabled: true,
    dialogueBeatGuard: true, // 최근 대사 의도·기능 반복 방지
    dialogueWindow: 2, // 대사 의도를 "또 하지 마" 목록에 올릴 최근 AI 답변 수 (1~6)
    // CardInject 연동: 캐시트 카테고리를 다음 전개 힌트의 참고 자료로 사용 (개입 중에만 주입)
    cardLinkEnabled: false,
    cardLinkSelected: {}, // { [캐릭터 키]: [카테고리 key, ...] }
    // 'always' = 채팅 토글이 곧 개입 스위치 (기본) / 'auto' = 서사 강도 태그를 감시하다 임계치에서 자동 개입
    armMode: 'always',
    nextBeatHints: true,
    repeatWindow: 3,
    maxBannedActs: 15, // 반복 금지 목록 총량 상한 — 넘치면 오래된 것부터 제외
    paceMode: 'auto', // 'auto'(온도 연동) | 'hold' | 'slow' | 'push'
    slowBurnEnabled: false,
    slowBurnIntensity: 'slow', // 'gentle'(단계당 1턴) | 'slow'(2턴) | 'verySlow'(3턴)
    slowBurnUserOverride: true, // 사용자가 직접 다음 단계 행동을 시작하면 제한보다 우선
    globalBans: [], // 전역 하드 리밋 — 모든 채팅의 무장 장면에 절대 금지로 주입
    styleLength: 'normal', // 'tight' | 'normal' | 'long' — 무장 중 응답 길이
    styleBalance: 'balanced', // 'dialogue' | 'balanced' | 'sensory' | 'internal' — 무장 중 묘사 밸런스
    exitBridge: true, // 해제 직후 한 번, 장면 마무리 지시 주입
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
    // v2: UI 추천값과 실제 기본값을 자동으로 통일한다.
    if (previousSchemaVersion < 2 && settings.paceMode === 'slow') settings.paceMode = 'auto';
    settings.settingsSchemaVersion = 2;
    // 상태 JSON은 짧으므로 과도한 출력 상한을 제한해 보조 호출 비용을 줄인다.
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

// 감시 중: 이 채팅에서 확장이 동작할 조건이 다 켜져 있는 상태 (최소한 상태 태그는 수집)
function isSupervising() {
    const settings = getSettings();
    const meta = getChatMeta(false);
    return Boolean(runtimeActive && settings.enabled && meta?.enabled);
}

// 완전 무장: 연속성·반복금지·진행 지시까지 전부 주입하는 상태
function isFullyArmed() {
    if (!isSupervising()) return false;
    const settings = getSettings();
    if (settings.armMode === 'always') return true;
    return Boolean(getChatMeta(false)?.autoArmed);
}

// ───────────────────────── 개입 시작/해제 ─────────────────────────

// 원탭 개입 시작/해제. armMode가 'always'면 채팅 토글 자체를 켜고 끄고,
// 'auto'면 서사 강도 자동 감지와 별개로 지금 바로 개입을 시작/해제한다.
function forceToggleArm() {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr.warning('먼저 설정에서 전체 사용을 켜주세요.', '🫧또또SFW');
        return;
    }
    const meta = getChatMeta();
    if (settings.armMode === 'always') {
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
        toastr.info(meta.enabled ? '이 채팅에서 개입을 시작해요.' : '이 채팅에서 개입을 껐어요.', '🫧또또SFW');
        updateUi();
        return;
    }
    if (!meta.enabled) meta.enabled = true; // 채팅 토글이 꺼져 있었으면 같이 켠다
    if (meta.autoArmed) {
        meta.autoArmed = false;
        meta.bridgePending = Boolean(settings.exitBridge);
        resetSlowBurnSession(meta);
        toastr.info('개입을 해제하고 대기로 돌아가요.', '🫧또또SFW');
    } else {
        meta.autoArmed = true;
        toastr.info('지금부터 연속성 개입을 시작해요.', '🫧또또SFW');
        if (settings.autoRefine) {
            clearTimeout(refineTimer);
            refineTimer = setTimeout(() => { void runRefine(); }, 300);
        }
    }
    saveChatMeta();
    updateUi();
}

// ───────────────────────── 상태 스냅샷 ─────────────────────────
// 값은 이중 언어로 저장: 주입은 영어(en), UI 표시는 한국어(ko).
// 태그에는 "English phrase || 한국어 구" 형식으로 오고, 구버전 데이터(단일 문자열)도 호환.

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
            appearance: toBi(info.appearance),
            position: toBi(info.position),
            holding: toBi(info.holding),
        };
    }
    const acts = Array.isArray(raw.acts) ? raw.acts : [];
    clean.acts = acts.map(toBi).filter(hasBi).slice(0, 64);
    const dialogueBeats = Array.isArray(raw.dialogue_beats)
        ? raw.dialogue_beats
        : Array.isArray(raw.dialogueBeats) ? raw.dialogueBeats : [];
    clean.dialogueBeats = dialogueBeats.map(toBi).filter(hasBi).slice(0, 4);
    const intensity = Number(raw.intensity);
    clean.intensity = Number.isFinite(intensity) ? Math.max(0, Math.min(10, Math.round(intensity))) : null;
    const stage = raw.stage === null || raw.stage === undefined ? NaN : Number(raw.stage);
    clean.stage = Number.isFinite(stage) ? Math.max(1, Math.min(6, Math.round(stage))) : null;
    const next = Array.isArray(raw.next) ? raw.next : [];
    clean.next = next.map(toBi).filter(hasBi).slice(0, 8);
    const hasCharacters = Object.values(clean.characters).some((info) => hasBi(info.appearance) || hasBi(info.position) || hasBi(info.holding));
    if (!hasBi(clean.location) && !hasCharacters && !clean.acts.length && !clean.dialogueBeats.length && clean.intensity === null && clean.stage === null && !clean.next.length) return null;
    return clean;
}

function stateCompletenessIssues(state, settings = getSettings()) {
    if (!state) return ['state'];
    const issues = [];
    if (!hasBi(state.location)) issues.push('location');
    const hasCharacterState = Object.values(state.characters ?? {}).some(
        (info) => hasBi(info.appearance) || hasBi(info.position) || hasBi(info.holding),
    );
    if (!hasCharacterState) issues.push('characters');
    if (!state.acts?.length) issues.push('acts');
    if (state.intensity === null || state.intensity === undefined) issues.push('intensity');
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
        // 스트리밍 중 잘렸거나 모델이 닫는 태그를 누락한 경우에도 기계용 내용이 본문에 노출되지 않게 제거한다.
        .replace(/```(?:json)?\s*<sfw_scene\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<sfw_scene\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<\/sfw_scene>\s*```/gi, '')
        .replace(/<\/sfw_scene>/gi, '');
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

// AI 메시지에서 상태 태그를 추출·저장하고 본문에서 제거. 변경 여부를 반환.
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

// 유효한 현재 상태: 수동 보정이 최신이면 그것을, 아니면 마지막 스냅샷을 사용.
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
        .replace(/\b(kissing|kissed|kisses)\b/g, 'kiss')
        .replace(/\b(touching|touched|touches)\b/g, 'touch')
        .replace(/\b(licking|licked|licks)\b/g, 'lick')
        .replace(/\b(holding|held|holds)\b/g, 'hold')
        .replace(/\b(pulling|pulled|pulls)\b/g, 'pull')
        .replace(/\b(pressing|pressed|presses)\b/g, 'press')
        .replace(/\b(caressing|caressed|caresses)\b/g, 'caress')
        .replace(/입(?:을|술을)?\s*(?:맞추\S*|맞대\S*)|입맞춤/g, '키스')
        .replace(/끌어안\S*|껴안\S*/g, '포옹')
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

// 최근 N턴의 전개(행위) 목록 — 오래된 것 → 최신 순.
// 총량이 maxBannedActs를 넘으면 오래된 것부터 잘라서 주입문 비대화를 막는다.
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
    // 중복 제거 (같은 전개가 여러 턴에 반복 기록된 경우 최신 것만)
    const seenActs = [];
    for (let i = rows.length - 1; i >= 0; i--) {
        rows[i].acts = rows[i].acts.filter((act) => {
            if (seenActs.some((seen) => actsAreSimilar(act, seen))) return false;
            seenActs.push(act);
            return true;
        });
    }
    // 총량 상한: 오래된 것부터 제거
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

// 실험실: 최근 2개의 AI 답변에서 사용한 대사의 목적·기능. 같은 의도는 최신 항목만 남긴다.
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
// CardInject가 캐릭터별로 저장한 카테고리(extensionSettings.cardinject.perChar[캐릭터키].categories)를
// 읽기 전용으로 참조한다. CardInject 쪽 코드는 건드리지 않는다.
// 용도: 다음 전개 힌트를 만들 때 캐릭터 시트의 성향·취향 카테고리를 참고 자료로 쓴다.
// 같은 카테고리를 CardInject에서 꺼두면(enabled 해제) 이 확장이 "무장 중에만" 주입하게 된다.
const CARD_LINK_STORE_KEY = 'cardinject';
const CARD_LINK_CHAR_LIMIT = 2500; // 참고 자료 총량 상한 (주입문 비대화 방지)
const CARD_LINK_HINT_RE = /preference|characteristic|habit|personality|성향|취향|선호|특징|습관|성격/i;

// 지금 채팅의 캐릭터들 (그룹 채팅이면 멤버 전체). CardInject와 같은 키 규칙: avatar 우선, 없으면 name.
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

// CardInject에 저장된 카테고리 목록 (내용이 있는 것만)
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

// CardInject 내용에는 {{char}}/{{user}} 매크로가 그대로 들어 있으므로 주입 전에 풀어준다.
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

// 선택된 카테고리를 "- 이름 — 카테고리: 내용" 줄 목록으로. 총량 상한을 넘으면 잘라낸다.
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
        'CHARACTER PREFERENCES (from the character sheet — inspiration for choosing what happens next, not a checklist. Never force them, and never contradict the current scene state, hard limits, or user-banned items):',
        text,
    ];
}

// ───────────────────────── 주입문 생성 ─────────────────────────

function buildStateLines(state) {
    const lines = [];
    if (hasBi(state.location)) lines.push(`- Location: ${biText(state.location, 'en')}`);
    for (const [name, info] of Object.entries(state.characters)) {
        const parts = [];
        if (hasBi(info.appearance)) parts.push(`appearance: ${biText(info.appearance, 'en')}`);
        if (hasBi(info.position)) parts.push(`position/posture: ${biText(info.position, 'en')}`);
        if (hasBi(info.holding)) parts.push(`holding/carrying: ${biText(info.holding, 'en')}`);
        if (parts.length) lines.push(`- ${name} — ${parts.join('; ')}`);
    }
    return lines;
}

// 최신 스냅샷의 다음 전개 후보 (반복 금지 목록·무시 목록과 겹치는 건 제외)
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

// 진행 속도 결정 — 'auto'면 강도 곡선이 지휘: 고조되는 중(~7)엔 전진, 절정 직전(8~9)엔 가속, 정점(10)엔 유지·심화
function resolvePace(settings, state) {
    if (settings.paceMode !== 'auto') {
        return PACE_INSTRUCTIONS[settings.paceMode] ?? PACE_INSTRUCTIONS.slow;
    }
    const intensity = Number(state?.intensity);
    if (!Number.isFinite(intensity)) return PACE_INSTRUCTIONS.slow;
    if (intensity >= 10) return PACE_INSTRUCTIONS.hold;
    if (intensity >= 8) return PACE_INSTRUCTIONS.push;
    return PACE_INSTRUCTIONS.slow;
}

function stageFromState(state) {
    const reported = state?.stage === null || state?.stage === undefined ? NaN : Number(state.stage);
    if (Number.isFinite(reported)) return Math.max(1, Math.min(6, Math.round(reported)));
    const intensity = Number(state?.intensity);
    if (!Number.isFinite(intensity)) return 1;
    if (intensity >= 10) return 6;
    if (intensity >= 8) return 5;
    if (intensity >= 7) return 4;
    if (intensity >= 5) return 3;
    if (intensity >= 3) return 2;
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
    if (state?.intensity !== null && state?.intensity !== undefined && Number.isFinite(Number(state.intensity))) {
        return { stage: stageFromState(state), source: 'intensity' };
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
    const target = sanitizeSlowBurnTarget(meta?.slowBurnTarget);
    const requiredTurns = clampSlowBurnTargetTurns(meta?.slowBurnTargetTurns);
    const completedTurns = meta?.slowBurnSessionActive
        ? Math.max(0, assistantMessages().length - slowBurnSessionStartCount())
        : 0;
    const active = Boolean(meta?.slowBurnTargetActive && target && meta?.slowBurnSessionActive);
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
        '[MANDATORY USER-TARGET SLOW-BURN LOCK — highest-priority scene rule]',
        `USER TARGET SCENE: ${targetLabel}. This is a direct scene requirement, not a suggestion, possible next beat, topic, metaphor, or optional preference.`,
        `EXACT RUN: ${progress.completedTurns}/${progress.requiredTurns} assistant responses completed. The response you are writing now is ${responseNumber}/${progress.requiredTurns}.`,
        `IMMEDIATE START: from the first paragraph of this response, the CHARACTER must begin or actively continue ${targetLabel} on-page. Do not delay it with setup, anticipation, unrelated dialogue, a different act, or a transition toward it.`,
        `Make ${targetLabel} the active, dominant, physically enacted scene throughout this entire response. Do not merely mention, discuss, promise, imagine, approach, summarize, or postpone it.`,
        'LANGUAGE RULE: the target may be written in Korean or another language. Understand its meaning directly before writing; never ignore it, quote it back, or treat it as unclear merely because the surrounding directive is English.',
        `The first through ${progress.requiredTurns}th responses ALL belong fully to ${targetLabel}. Even response ${progress.requiredTurns}/${progress.requiredTurns} must remain inside the target scene through its ending; only the following response may transition away.`,
        'ABSOLUTE HOLD: do not leave, replace, resolve, wind down, fade out, time-skip, cut to aftermath, fall asleep, separate, or move to a different scene while this target run is active. End on an open beat that can continue naturally.',
        'REPETITION EXCEPTION: the target scene itself is REQUIRED and is never prohibited by the recent-beat repetition list. Only exact micro-actions and wording should vary. Keep the target continuous while adding fresh dialogue, reactions, sensations, pacing, and emotional shifts.',
        `There are ${progress.remaining} target response(s), including this one, still required. Earlier chat messages, swipes, regenerations, and Continue expansions do not satisfy this count.`,
        'PRIORITY: if continuity, recent-beat avoidance, pacing, a suggested next beat, stage guidance, character hesitation, or any lower-priority instruction conflicts with immediately enacting and maintaining this target, this USER-TARGET LOCK wins. Preserve established physical facts while changing only what is necessary through explicit on-page actions. Hard safety limits and an explicit refusal from the USER still always apply.',
        'In the hidden state report, set "stage" to the stage actually reached at the END of the response (integer 1-6).',
    ];
}

// 상태 보고 지시 뒤에 한 번 더 배치해, 긴 연속성 프롬프트 속에서 목표가 묻히지 않게 한다.
function buildTargetFinalEnforcementLines() {
    const progress = slowBurnTargetProgress();
    if (!progress.active) return [];
    const targetLabel = JSON.stringify(progress.target);
    const responseNumber = Math.min(progress.requiredTurns, progress.completedTurns + 1);
    return [
        '[FINAL TARGET ENFORCEMENT — obey before writing the prose]',
        `RESPONSE ${responseNumber}/${progress.requiredTurns}: enact ${targetLabel} immediately from the first paragraph and keep it as the main on-page action through the final paragraph.`,
        `Do not substitute a related act, remain in preparation, ask permission again when consent is already established in context, or end before ${targetLabel} is actively happening.`,
        'The target itself overrides the recent-beat repetition ban; vary only its specific movements, dialogue, reactions, and sensory details.',
        'Before finishing, silently verify: (1) the target happened on-page, (2) it remained the dominant scene, and (3) the ending stays open for the next required target response. If any answer is no, revise the prose before returning it.',
    ];
}

function buildSlowBurnLines(settings) {
    if (slowBurnTargetProgress().active) return buildTargetSlowBurnLines();
    const progress = slowBurnProgress(settings);
    const current = SLOW_BURN_STAGES[progress.stage];
    const maximum = SLOW_BURN_STAGES[progress.maxStage];
    const lines = [
        '[MANDATORY SLOW-BURN LOCK — highest-priority scene progression rule]',
        `SLOW-BURN SESSION: ${progress.sessionTurns}/${progress.requiredTurns} CHARACTER responses completed since this mode was activated.`,
        `CURRENT STAGE ${progress.stage}/6: ${current.en}.`,
        `MAXIMUM CHARACTER-INITIATED STAGE THIS RESPONSE: ${progress.maxStage}/6 (${maximum.en}).`,
        'HARD RULE: Advance by at most one stage per response. Never begin and complete a new stage in the same response. Add one meaningful new beat while giving the current beat room to breathe.',
        'Slow burn means fresh tension, dialogue, reaction, and sensory detail — not repeating the same action, freezing the scene, padding, or rephrasing what already happened.',
        'Do not skip ahead, summarize omitted progression, fade to black, jump forward in time, cut to an aftermath, or move to a new scene.',
    ];
    if (progress.recoveryPending) {
        lines.push('PREMATURE-END RECOVERY: the previous response attempted to end or cool down the scene before the slow-burn lock was satisfied. Do not accept that ending as final and do not continue into aftermath. Resume from the last active beat, preserving continuity, and keep the scene open.');
    }
    if (!progress.canConclude) {
        lines.push('ABSOLUTE NO-CONCLUSION LOCK: Do NOT finish, conclude, wind down, separate, fall asleep, cut away, or transition to the aftermath in this response. End on an open active beat that requires another turn. This rule applies even at stage 6.');
    }
    if (progress.sessionRemaining > 0) {
        lines.push(`The scene must remain active for at least ${progress.sessionRemaining} more CHARACTER response(s). This count started when slow-burn was turned on; earlier chat messages do not count.`);
    }
    if (progress.locked) {
        lines.push('STAGE LOCKED BY USER: remain within the current stage until the lock is released. Deepen it without escalating or regressing.');
    } else if (progress.stageRemaining > 0) {
        lines.push(`Remain in the current stage for at least ${progress.stageRemaining} more CHARACTER response(s) before entering the next stage.`);
    } else if (progress.stage < 6) {
        lines.push('You may enter the next stage if it follows naturally, but you are not required to do so.');
    } else if (progress.canConclude) {
        lines.push('The minimum session and final-stage residence are both satisfied. A conclusion is now permitted if it follows naturally, but it is not required.');
    } else {
        lines.push('Remain in the final stage without concluding until the no-conclusion lock is released.');
    }
    if (settings.slowBurnUserOverride) {
        lines.push('USER-LED STAGE OVERRIDE: if the USER explicitly initiates a later-stage action, follow that action naturally. This may bypass only the stage cap. It NEVER bypasses the minimum-response count or the ABSOLUTE NO-CONCLUSION LOCK. Mere passive reaction is not an override.');
    }
    const overrideNote = settings.slowBurnUserOverride ? ', except that an explicit USER-led action may raise the stage without permitting conclusion' : '';
    lines.push(`In the hidden state report, set "stage" to the stage actually reached at the END of the response (integer 1-6; current cap ${progress.maxStage}${overrideNote}).`);
    return lines;
}

const STATE_REPORT_LINES = [
    'STATE REPORT: End your response with exactly one state block in this format (single line, valid JSON). It is machine-read and hidden from the reader — include it every time:',
    '<sfw_scene>{"_status":"updated","location":"short English phrase || 짧은 한국어 구","characters":{"이름":{"appearance":"current appearance/notable state, English || 한국어","position":"current posture/position, English || 한국어","holding":"what they are currently holding/carrying, English || 한국어"}},"acts":["2-4 significant new beats in this response, each \'English || 한국어\'"],"intensity":0,"next":["2-3 fresh beats the scene could move to next, each \'English || 한국어\'"]}</sfw_scene>',
    'Every string value must be a bilingual pair: concise English first, then " || ", then natural Korean. Use the same character names as in the chat.',
    '"acts" rules: list ONLY substantive beats — plot, relationship, or emotional developments that matter for repetition control. Skip mundane logistics (snacks, drinks, blankets, remote controls, small housekeeping actions). 2-4 items maximum, only what is NEW in this response.',
    ...INTENSITY_SCALE_LINES,
    'Update every field to reflect the situation at the END of your response. "next" must not repeat anything from "acts".',
    'The optional top-level "_status" field is the ONLY place for a change acknowledgement: use "no_change" there if you need to signal that tracked state did not change; otherwise use "updated". All real state fields must still repeat their complete current values.',
    'Never use placeholders such as "no change", "no changes", "unchanged", or "same" in location, character state, acts, intensity, or next. Never output any acknowledgement, status note, or meta-comment outside the <sfw_scene> block.',
];

const SLOW_BURN_STATE_REPORT_LINES = [
    'STATE REPORT: End your response with exactly one state block in this format (single line, valid JSON). It is machine-read and hidden from the reader — include it every time:',
    '<sfw_scene>{"_status":"updated","location":"short English phrase || 짧은 한국어 구","characters":{"이름":{"appearance":"current appearance/notable state, English || 한국어","position":"current posture/position, English || 한국어","holding":"what they are currently holding/carrying, English || 한국어"}},"acts":["2-4 significant new beats in this response, each \'English || 한국어\'"],"intensity":0,"stage":1,"next":["2-3 fresh beats the scene could move to next, each \'English || 한국어\'"]}</sfw_scene>',
    'Every string value must be a bilingual pair: concise English first, then " || ", then natural Korean. Use the same character names as in the chat.',
    '"acts" rules: list ONLY substantive beats — plot, relationship, or emotional developments that matter for repetition control. Skip mundane logistics (snacks, drinks, blankets, remote controls, small housekeeping actions). 2-4 items maximum, only what is NEW in this response.',
    ...INTENSITY_SCALE_LINES,
    '"stage" is the slow-burn progression stage as an integer from 1 to 6. Update every field to reflect the situation at the END of your response. "next" must not repeat anything from "acts".',
    'The optional top-level "_status" field is the ONLY place for a change acknowledgement: use "no_change" there if you need to signal that tracked state did not change; otherwise use "updated". All real state fields must still repeat their complete current values.',
    'Never use placeholders such as "no change", "no changes", "unchanged", or "same" in location, character state, acts, intensity, stage, or next. Never output any acknowledgement, status note, or meta-comment outside the <sfw_scene> block.',
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
        '"dialogue_beats" rules: list 0-3 conversational purposes used by the CHARACTER in this response, not quotations or surface wording. Examples: asks for reassurance, repeats the same demand or plea, restates a promise, gives the same compliment, provokes a reaction, or asks the same question. Use [] when there is no spoken dialogue.',
    );
    return lines;
}

// 감시 모드('auto') 전용 초경량 주입 — 장면 강도 한 줄만 요청 (평범한 장면에는 개입하지 않음)
const MONITOR_REPORT_LINES = [
    '[Scene Monitor] Write the response normally, then append exactly one machine-readable state line in this format. It is hidden from the reader:',
    '<sfw_scene>{"_status":"updated","intensity":0}</sfw_scene>',
    ...INTENSITY_SCALE_LINES,
    'Report "intensity" factually. If you need to signal no change, use only the optional top-level "_status":"no_change" inside <sfw_scene>; otherwise use "updated". Never put a change acknowledgement or any other machine-status text outside the tag.',
];

function buildInjection() {
    const settings = getSettings();
    const { state } = effectiveState();
    const targetActive = slowBurnTargetProgress().active;
    const dialogueGuard = Boolean(settings.dialogueBeatGuard);

    // 무장 전: 해제 브릿지가 걸려 있으면 마무리 지시를 한 번 주입.
    // 'auto' 모드는 그 외에도 강도 한 줄만 요청해 자동 개입 여부를 감시한다.
    if (!isFullyArmed()) {
        const parts = [];
        if (settings.exitBridge && getChatMeta(false)?.bridgePending) parts.push(...BRIDGE_LINES);
        if (settings.armMode === 'auto') parts.push(...MONITOR_REPORT_LINES);
        return parts.join('\n');
    }

    const actRows = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow);
    const pace = resolvePace(settings, state);

    const sections = ['[Scene Continuity Directive]'];

    if (state) {
        sections.push(
            'CURRENT SCENE STATE (established facts — never contradict them):',
            ...buildStateLines(state),
            'Appearance changes, positions, locations, and held items only change through explicit on-page actions in your response. Never silently reset or teleport anything.',
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
                    ? `ALREADY HAPPENED in the last ${actRows.length} response(s) — avoid copying these exact micro-beats, but NEVER use this list to avoid, delay, or replace the active USER TARGET SCENE:`
                    : `ALREADY HAPPENED in the last ${actRows.length} response(s) — do NOT repeat these beats, actions, or their near-identical variations:`,
                ...actRows.map((row) => `- ${row.acts.map((act) => biText(act, 'en')).join(', ')}`),
            );
        }
        if (customBans.length) {
            sections.push(`USER-BANNED (permanent for this chat — never do these): ${customBans.join(', ')}`);
        }
        sections.push(targetActive
            ? 'Continue the required target scene while making its exact micro-actions, wording, reactions, and sensory details new.'
            : 'Repeating a listed beat with different wording still counts as repetition. Bring something new.');
    }

    if (dialogueGuard) {
        const dialogueRows = recentDialogueBeats();
        if (dialogueRows.length) {
            sections.push(
                '',
                `DIALOGUE INTENTS ALREADY USED in the last ${dialogueRows.length} CHARACTER response(s) — do not repeat the same conversational function merely by paraphrasing it:`,
                ...dialogueRows.map((row) => `- ${row.beats.map((beat) => biText(beat, 'en')).join(', ')}`),
                'Keep the character voice, but give the spoken dialogue a genuinely new purpose or advance what is being said. Do not repeat the same pleasure-check, plea, praise, taunt, ownership claim, permission request, or reaction request in different words.',
                'EXCEPTIONS: a direct answer to the USER, a necessary consent or safety clarification, and a deliberately meaningful refrain/catchphrase may be used when context truly requires it.',
                targetActive ? 'This guard must never be used to avoid, delay, or replace the active USER TARGET SCENE.' : '',
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
            if (settings.slowBurnEnabled) sections.push('These suggestions are subordinate to the mandatory slow-burn stage cap and no-conclusion lock. Ignore any suggestion that would skip, finish, or wind down the scene too early.');
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
        ? '"next" rule: draw the candidates from the CHARACTER PREFERENCES above when they fit the current scene and stage. Keep them fresh — never repeat "acts" or anything already banned.'
        : '';
    sections.push('', ...stateReportLines(settings.slowBurnEnabled, dialogueGuard, nextGuidance));

    // 가장 마지막 지시가 목표 실행 명령이 되도록 다시 고정한다.
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
        // 채팅 토글로 수동 해제한 뒤에는 감시 자체가 꺼져도 다음 생성 한 번의 브릿지만 통과시킨다.
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
        if (settings.slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
        const prompt = buildInjection();
        if (!prompt) return;
        getContext().setExtensionPrompt(PROMPT_KEY, prompt, PROMPT_POSITION_IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
        // 해제 브릿지는 딱 한 번만: 이번 생성에 실렸으면 플래그를 끈다 (미리보기는 소모하지 않음)
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

// ───────────────────────── 보조 AI 보정 (하이브리드 폴백) ─────────────────────────

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
        ? '\n- "next" should draw on the CHARACTER PREFERENCES given in the user message where they fit the current scene; they are inspiration only, never a checklist.'
        : '';
    const stageRule = slowBurnEnabled
        ? '\n- "stage" is the scene\'s slow-burn progression as an integer: 1 tension/atmosphere, 2 gaze/words/proximity, 3 first meaningful exchange/contact, 4 deepening connection/reactions, 5 turning point/decisive escalation, 6 resolution or conclusion permitted.'
        : '';
    const system = `You are a scene-state tracker for a fiction roleplay log. Read the log excerpt and return ONLY a JSON object, no markdown, no commentary.

Schema:
{"location":"short English phrase || 짧은 한국어 구","characters":{"name":{"appearance":"current appearance/notable state, English || 한국어","position":"current posture/position, English || 한국어","holding":"what they are currently holding/carrying, English || 한국어"}}${dialogueSchema},"acts":["2-4 significant beats from the most recent CHARACTER message only, each 'English || 한국어'"],"intensity":0${stageSchema},"next":["2-3 fresh beats the scene could move to next, each 'English || 한국어'"]}

Rules:
- Every string value is a bilingual pair: concise English first, then " || ", then natural Korean.
- Describe the state at the END of the log, factually and concisely. Note significant appearance changes explicitly.
- "acts" must cover only the final CHARACTER message. List ONLY substantive beats (plot, relationship, or emotional developments); skip mundane logistics like snacks, drinks, blankets, or remote controls.
${dialogueGuard ? '- "dialogue_beats" must list 0-3 conversational intents/functions from spoken CHARACTER dialogue in the final CHARACTER message only. Describe the purpose, not exact wording or quotations. Use [] if there is no spoken dialogue.\n' : ''}${INTENSITY_SCALE_LINES.join('\n')}${stageRule}
- "next" must not repeat anything already listed in "acts".${preferenceRule}
- Include every present character. Use the exact names from the log.
- If something is unknown, use an empty string. Return the JSON object only.`;
    const user = `${preferenceText ? `CHARACTER PREFERENCES (reference for "next" only):\n${preferenceText}\n\n` : ''}Log excerpt (oldest first):\n\n${buildRefineInput()}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

// 백엔드가 토큰 상한 값을 거부한 오류인지 (Gemini: "supported range is from 1 to 65537" 등)
function isTokenLimitError(error) {
    return /max_?output_?tokens|max_tokens|maxOutputTokens|supported range|output token/i.test(String(error?.message ?? error ?? ''));
}

async function requestRefine(signal) {
    const context = getContext();
    const settings = getSettings();
    const prompt = refinePromptMessages();
    const maxTokens = Number(settings.refineMaxTokens) || DEFAULT_SETTINGS.refineMaxTokens;
    const profileId = String(settings.refineProfileId ?? '').trim();

    // 상한을 거부하는 백엔드를 만나면 더 작은 값으로 자동 재시도
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
        if (manual) toastr.info('분석할 AI 응답이 아직 없어요.', '🫧또또SFW');
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
        // 보정 결과를 최신 AI 메시지의 현재 스와이프에도 붙여야 반복 목록과 슬로우번 체류 턴이 정상 계산된다.
        const latestMessage = assistantMessages().at(-1);
        if (latestMessage) {
            const store = getMessageStore(latestMessage);
            store.swipes[String(currentSwipeIndex(latestMessage))] = { state, at: refinedAt };
            persistChat();
        }
        meta.manualState = { state, at: refinedAt, source: 'ai-refine' };
        saveChatMeta();
        if (manual) toastr.success('보조 AI가 장면 상태를 다시 잡았어요.', '🫧또또SFW');
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') return false;
        console.error(`${LOG_PREFIX} 보정 분석 실패`, error);
        if (manual) toastr.error(`보정 분석 실패: ${error?.message ?? error}`, '🫧또또SFW');
        return false;
    } finally {
        refineRunning = false;
        refineAbortController = null;
        if (runtimeActive) updateUi();
    }
}

function scheduleAutoRefine() {
    const settings = getSettings();
    // 무장 상태에서만 자동 보정 — 대기(감시) 중 태그가 없는 건 정상이므로 호출 낭비 금지
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
        // 새 스냅샷이 수동 보정보다 최신이므로 수동 보정은 자연히 밀려남
        if (meta.manualState && Number(meta.manualState.at ?? 0) < Date.now()) meta.manualState = null;
        saveChatMeta();
    }
    const targetProgress = slowBurnTargetProgress();
    if (targetProgress.active && targetProgress.completedTurns >= targetProgress.requiredTurns) {
        meta.slowBurnTargetActive = false;
        meta.slowBurnTargetCompleted = true;
        meta.slowBurnRecoveryPending = false;
        saveChatMeta();
        toastr.success(`“${targetProgress.target}” ${targetProgress.requiredTurns}회 진행을 채웠어요. 다음 AI 답변부터는 전환할 수 있어요.`, '🫧또또SFW');
    }
    // 강도 자동 무장/해제 (히스테리시스: 켜짐 5↑, 꺼짐 2↓) — 'auto' 모드 전용 ('always' 모드는 채팅 토글이 곧 개입)
    if (state?.intensity !== null && state?.intensity !== undefined && settings.armMode === 'auto') {
        if (!meta.autoArmed && state.intensity >= AUTO_ARM_ON) {
            meta.autoArmed = true;
            saveChatMeta();
            toastr.info(`장면 강도 ${state.intensity}/10 — 연속성 개입을 시작해요.`, '🫧또또SFW');
            // 감시 모드에서는 강도만 수집했으므로, 무장 직후 보조 AI로 전체 상태를 백필
            if (settings.autoRefine) {
                clearTimeout(refineTimer);
                refineTimer = setTimeout(() => { void runRefine(); }, 400);
            }
        } else if (meta.autoArmed && state.intensity <= AUTO_ARM_OFF) {
            const prematureSlowBurnEnd = settings.slowBurnEnabled
                && meta.slowBurnSessionActive
                && !slowBurnProgress(settings).canConclude;
            if (prematureSlowBurnEnd) {
                const firstDetection = !meta.slowBurnRecoveryPending;
                meta.slowBurnRecoveryPending = true;
                meta.autoArmed = true;
                meta.bridgePending = false;
                saveChatMeta();
                if (firstDetection) toastr.warning('최소 턴 전에 장면 종료를 감지했어요. 개입을 유지하고 다음 응답에서 장면을 이어가게 해요.', '🫧또또SFW');
            } else {
                meta.autoArmed = false;
                meta.bridgePending = Boolean(settings.exitBridge); // 다음 생성 한 번은 장면 마무리 지시
                resetSlowBurnSession(meta);
                saveChatMeta();
                toastr.info(`장면 강도 ${state.intensity}/10 — 개입을 해제하고 대기로 돌아가요.`, '🫧또또SFW');
            }
        } else if (state.intensity > AUTO_ARM_OFF && meta.slowBurnRecoveryPending) {
            meta.slowBurnRecoveryPending = false;
            saveChatMeta();
        }
    }
    if (changed) {
        rerenderMessage(index, message);
        persistChat();
    }
    const completenessState = state ?? snapshotForMessage(message)?.state ?? null;
    const completenessIssues = found ? stateCompletenessIssues(completenessState, settings) : [];
    if (!found || completenessIssues.length) {
        const reason = found ? `상태 태그 불완전 (${completenessIssues.join(', ')})` : '상태 태그 누락';
        console.debug(`${LOG_PREFIX} ${reason} — 보조 AI 보정 ${settings.autoRefine ? '예약' : '비활성'}`);
        scheduleAutoRefine();
    }
    updateUi();
}

// ───────────────────────── UI ─────────────────────────

function element(id) {
    return document.getElementById(id);
}

function setTab(tab) {
    document.querySelectorAll('#ttotto-sfw-settings [data-tsf-tab]').forEach((button) => {
        const active = button.dataset.tsfTab === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    // hidden 속성만으로는 팝업/테마 CSS와 충돌할 수 있어 인라인 스타일로도 강제한다
    const panels = { state: element('tsf-panel-state'), settings: element('tsf-panel-settings') };
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
    const select = element('tsf-refine-profile');
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
    const card = element('tsf-slow-burn-card');
    card.hidden = !settings.slowBurnEnabled;
    if (card.hidden) return;

    const stageHead = card.querySelector('.tsf-slow-burn-head');
    const stageControls = card.querySelector('.tsf-slow-burn-controls');
    if (stageHead) stageHead.hidden = !settings.slowBurnEnabled;
    if (stageControls) stageControls.hidden = !settings.slowBurnEnabled;

    const progress = slowBurnProgress(settings);
    const targetProgress = progress.target;
    const targetInput = element('tsf-slow-burn-target');
    const targetTurnsInput = element('tsf-slow-burn-target-turns');
    if (document.activeElement !== targetInput) targetInput.value = targetProgress.target;
    if (document.activeElement !== targetTurnsInput) targetTurnsInput.value = String(targetProgress.requiredTurns);
    targetInput.disabled = targetProgress.active;
    targetTurnsInput.disabled = targetProgress.active;
    const targetBox = targetInput.closest('.tsf-slow-burn-target-box');
    targetBox?.classList.toggle('is-active', targetProgress.active);
    element('tsf-slow-burn-target-start').textContent = targetProgress.active ? '↻ 처음부터 다시' : '🔥 목표 시작';
    element('tsf-slow-burn-target-stop').disabled = !targetProgress.active;
    element('tsf-slow-burn-target-status').textContent = targetProgress.active
        ? `“${targetProgress.target}” · ${Math.min(targetProgress.completedTurns, targetProgress.requiredTurns)}/${targetProgress.requiredTurns}회 진행 중 · 다음 AI 답변도 이 장면을 유지`
        : targetProgress.completed
            ? `“${targetProgress.target}” · ${targetProgress.requiredTurns}/${targetProgress.requiredTurns}회 완료 · 다음 AI 답변부터 전환 가능`
            : targetProgress.target
                ? `“${targetProgress.target}”을(를) ${targetProgress.requiredTurns}회 진행할 준비가 됐어요.`
                : '장면과 횟수를 정하면 다음 AI 답변부터 정확히 그 횟수만큼 유지해요.';
    const stage = SLOW_BURN_STAGES[progress.stage];
    const sourceLabel = {
        manual: '수동 선택',
        reported: 'AI 단계 감지',
        intensity: '강도에서 감지',
        default: '초기 단계',
    }[progress.source] ?? '자동 감지';

    element('tsf-slow-burn-stage').textContent = `${progress.stage}단계 · ${stage.ko}`;
    const sessionText = `활성화 후 ${Math.min(progress.sessionTurns, progress.requiredTurns)}/${progress.requiredTurns}턴`;
    const stageText = `현재 단계 ${Math.min(progress.turns, progress.requiredTurns)}/${progress.requiredTurns}턴`;
    element('tsf-slow-burn-progress').textContent = progress.locked
        ? `${sessionText} · ${stageText} · 단계 고정 중`
        : progress.recoveryPending
            ? `${sessionText} · 조기 종료 감지, 장면 이어가기 대기`
            : `${sessionText} · ${stageText}`;
    element('tsf-slow-burn-source').textContent = sourceLabel;
    element('tsf-slow-burn-lock').textContent = progress.locked ? '🔓 고정 해제' : '🔒 단계 고정';
    element('tsf-slow-burn-prev').disabled = progress.stage <= 1;
    element('tsf-slow-burn-next').disabled = progress.stage >= 6;
    element('tsf-slow-burn-auto').disabled = progress.source !== 'manual' && !progress.locked;
}

function renderCardLinkPanel(settings) {
    const box = element('tsf-card-link-box');
    if (!box) return;
    box.hidden = !settings.cardLinkEnabled;
    element('tsf-card-link').checked = Boolean(settings.cardLinkEnabled);
    if (!settings.cardLinkEnabled) return;

    const list = element('tsf-card-link-list');
    const note = element('tsf-card-link-note');
    list.replaceChildren();

    const { available, rows } = cardLinkOptions();
    if (!available) {
        note.textContent = 'CardInject 데이터를 찾지 못했어요. CardInject를 설치하고 이 캐릭터의 캐시트를 분석한 뒤 새로고침해주세요.';
        return;
    }
    if (!rows.length) {
        note.textContent = '이 채팅 캐릭터에 저장된 CardInject 카테고리가 없어요. CardInject에서 분석하거나 직접 칸을 추가한 뒤 새로고침해주세요.';
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
        label.className = 'tsf-setting-row tsf-card-link-row';
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
        ? `⚠️ 고른 ${picked}개 중 ${duplicated}개가 CardInject에서도 켜져 있어서 프롬프트에 두 번 들어가요. CardInject에서 그 카테고리를 끄면 개입 중일 때만 주입돼요. (★ = 이름이 성향·취향 관련처럼 보이는 카테고리)`
        : `고른 ${picked}개는 개입 중일 때만 주입돼요. (★ = 이름이 성향·취향 관련처럼 보이는 카테고리)`;
}

function renderStatePanel() {
    const { state, source } = effectiveState();
    const settings = getSettings();
    renderSlowBurnPanel(settings);
    renderCardLinkPanel(settings);
    const sourceLabel = { tag: '응답 태그에서 추적됨', 'ai-refine': '보조 AI 보정 결과', manual: '수동 수정됨', none: '아직 기록 없음' }[source] ?? source;
    element('tsf-state-source').textContent = refineRunning ? '보조 AI 분석 중…' : sourceLabel;

    const intensityBadge = element('tsf-intensity');
    if (state?.intensity !== null && state?.intensity !== undefined) {
        intensityBadge.hidden = false;
        intensityBadge.textContent = `📈 ${state.intensity}/10`;
        intensityBadge.classList.toggle('is-hot', state.intensity >= AUTO_ARM_ON);
    } else {
        intensityBadge.hidden = true;
    }

    const locationInput = element('tsf-state-location');
    if (document.activeElement !== locationInput) locationInput.value = biText(state?.location);

    const list = element('tsf-char-list');
    list.replaceChildren();
    const characters = state?.characters ?? {};
    for (const [name, info] of Object.entries(characters)) {
        const row = document.createElement('div');
        row.className = 'tsf-char-row';
        const title = document.createElement('strong');
        title.textContent = name;
        row.append(title);
        for (const [field, label] of [['appearance', '외형·복장'], ['position', '자세·위치'], ['holding', '소지품']]) {
            const wrap = document.createElement('label');
            wrap.className = 'tsf-char-field';
            const caption = document.createElement('span');
            caption.textContent = label;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'text_pole';
            input.value = biText(info[field]);
            input.addEventListener('change', () => {
                applyManualEdit((draft) => {
                    if (!draft.characters[name]) draft.characters[name] = { appearance: '', position: '', holding: '' };
                    draft.characters[name][field] = input.value;
                });
            });
            wrap.append(caption, input);
            row.append(wrap);
        }
        list.append(row);
    }
    element('tsf-char-empty').hidden = Object.keys(characters).length > 0;

    const actsList = element('tsf-acts-list');
    actsList.replaceChildren();
    const rows = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow);
    for (const row of rows) {
        for (const act of row.acts) {
            const chip = document.createElement('span');
            chip.className = 'tsf-act-chip';
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
    element('tsf-acts-empty').hidden = rows.length > 0;
    element('tsf-acts-summary').textContent = `최근 ${settings.repeatWindow}턴 기준`;

    // 개발자 실험실: 최근 대사 의도 목록
    const dialogueSection = element('tsf-dialogue-section');
    const dialogueEnabled = Boolean(settings.dialogueBeatGuard);
    const dialogueSummary = element('tsf-dialogue-summary');
    if (dialogueSummary) dialogueSummary.textContent = `최근 ${settings.dialogueWindow}개의 AI 답변에서 이미 사용한 대사의 목적이에요.`;
    dialogueSection.hidden = !dialogueEnabled;
    const dialogueList = element('tsf-dialogue-list');
    dialogueList.replaceChildren();
    const dialogueRows = dialogueEnabled ? recentDialogueBeats() : [];
    for (const row of dialogueRows) {
        for (const beat of row.beats) {
            const chip = document.createElement('span');
            chip.className = 'tsf-act-chip';
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
    element('tsf-dialogue-empty').hidden = dialogueRows.length > 0;

    // 다음 전개 후보
    const nextList = element('tsf-next-list');
    nextList.replaceChildren();
    const targetActive = slowBurnTargetProgress().active;
    const beats = settings.nextBeatHints && !targetActive ? nextBeatCandidates() : [];
    for (const beat of beats) {
        const chip = document.createElement('span');
        chip.className = 'tsf-act-chip tsf-next-chip';
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
    const nextSection = element('tsf-next-section');
    nextSection.hidden = !settings.nextBeatHints || targetActive;
    element('tsf-next-empty').hidden = !settings.nextBeatHints || targetActive || beats.length > 0;

    // 수동 금지 목록
    const customList = element('tsf-custom-ban-list');
    customList.replaceChildren();
    const meta = getChatMeta(false);
    for (const ban of meta?.customBans ?? []) {
        const chip = document.createElement('span');
        chip.className = 'tsf-act-chip tsf-custom-chip';
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

    // 전역 하드 리밋 목록
    const globalList = element('tsf-global-ban-list');
    globalList.replaceChildren();
    for (const ban of settings.globalBans ?? []) {
        const chip = document.createElement('span');
        chip.className = 'tsf-act-chip tsf-custom-chip';
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

}


// ───────────────────────── 주입문 크기 표시 (글자 수 + 토큰 수) ─────────────────────────
// 토큰 수는 ST에 지금 설정된 토크나이저로 세고, 못 세면 대략치(약)로 보여준다.
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
    const sizeElement = element('tsf-prompt-size');
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
    // 정확한 값이 오기 전까지는 대략치를 먼저 보여줘서 깜빡이지 않게 한다.
    sizeElement.textContent = `${charLabel} · 약 ${estimateTokens(prompt).toLocaleString()}토큰`;
    const seq = ++promptTokenSeq;
    void countPromptTokens(prompt).then(({ count, exact }) => {
        if (seq !== promptTokenSeq) return;
        const label = `${exact ? '' : '약 '}${count.toLocaleString()}토큰`;
        promptTokenCache = { text: prompt, label };
        const current = element('tsf-prompt-size');
        if (current) current.textContent = `${charLabel} · ${label}`;
    });
}

function updateUi() {
    if (!uiReady) return;
    try {
        const settings = getSettings();
        const meta = getChatMeta(false);

        element('tsf-enabled').checked = Boolean(settings.enabled);
        element('tsf-chat-enabled').checked = Boolean(meta?.enabled);
        element('tsf-repeat-window').value = String(settings.repeatWindow);
        element('tsf-repeat-window-value').textContent = `${settings.repeatWindow}턴`;
        element('tsf-max-banned').value = String(settings.maxBannedActs);
        element('tsf-max-banned-value').textContent = `${settings.maxBannedActs}개`;
        element('tsf-pace-mode').value = String(settings.paceMode);
        element('tsf-pace-mode').disabled = Boolean(settings.slowBurnEnabled);
        element('tsf-pace-mode-note').textContent = settings.slowBurnEnabled
            ? '슬로우번이 켜져 있어 현재는 단계별 진행 제한이 대신 적용돼요.'
            : '슬로우번을 켜면 이 설정 대신 단계별 진행 제한이 적용돼요.';
        element('tsf-slow-burn-enabled').checked = Boolean(settings.slowBurnEnabled);
        element('tsf-slow-burn-intensity').value = String(settings.slowBurnIntensity);
        element('tsf-slow-burn-intensity').disabled = !settings.slowBurnEnabled;
        element('tsf-slow-burn-user-override').checked = Boolean(settings.slowBurnUserOverride);
        element('tsf-slow-burn-user-override').disabled = !settings.slowBurnEnabled;
        element('tsf-style-length').value = String(settings.styleLength);
        element('tsf-style-balance').value = String(settings.styleBalance);
        element('tsf-exit-bridge').checked = Boolean(settings.exitBridge);
        element('tsf-arm-mode').value = String(settings.armMode);
        element('tsf-next-hints').checked = Boolean(settings.nextBeatHints);
        element('tsf-dialogue-guard').checked = Boolean(settings.dialogueBeatGuard);
        element('tsf-dialogue-window').value = String(settings.dialogueWindow);
        element('tsf-dialogue-window').disabled = !settings.dialogueBeatGuard;
        element('tsf-dialogue-window-value').textContent = `${settings.dialogueWindow}개`;
        element('tsf-auto-refine').checked = Boolean(settings.autoRefine);

        const armed = isSupervising();
        const intensity = effectiveState().state?.intensity;
        const intensityText = intensity !== null && intensity !== undefined ? ` (강도 ${intensity}/10)` : '';
        element('tsf-header-status').textContent = !settings.enabled
            ? '꺼져 있어요'
            : !meta?.enabled
                ? '이 채팅에서는 쉬는 중'
                : refineRunning
                    ? '보조 AI 분석 중…'
                    : settings.armMode === 'auto'
                        ? (meta?.autoArmed ? `개입 중이에요${intensityText}` : `강도를 감시하는 중이에요${intensityText}`)
                        : '장면을 지켜보는 중이에요';

        element('tsf-refine').disabled = refineRunning;
        element('tsf-force-arm-label').textContent = isFullyArmed() ? '개입 해제' : '지금 개입';
        renderStatePanel();

        const preview = element('tsf-prompt-preview');
        if (!preview.hidden) {
            const prompt = armed ? buildInjection() : '';
            element('tsf-prompt-text').textContent = prompt || '(지금은 주입할 내용이 없어요)';
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
    // 탭 클릭은 루트 위임으로 — 패널이 팝업으로 이동해도, 어떤 환경에서도 확실히 잡힌다
    const root = document.getElementById('ttotto-sfw-settings');
    root.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-tsf-tab]');
        if (button && root.contains(button)) {
            event.preventDefault();
            event.stopPropagation();
            setTab(button.dataset.tsfTab);
        }
    });

    const syncSlowBurnSession = (settings) => {
        const meta = getChatMeta(false);
        if (!meta) return;
        resetSlowBurnSession(meta);
        saveChatMeta();
        if (settings.enabled && settings.slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
    };
    bindSetting('tsf-enabled', 'enabled', Boolean, syncSlowBurnSession);
    bindSetting('tsf-arm-mode', 'armMode', String, (settings) => {
        // 수동으로 전환하면 자동 무장 상태는 리셋
        if (settings.armMode === 'always') {
            const meta = getChatMeta(false);
            if (meta) {
                meta.autoArmed = false;
                resetSlowBurnSession(meta);
                saveChatMeta();
            }
        }
    });
    bindSetting('tsf-next-hints', 'nextBeatHints', Boolean);
    bindSetting('tsf-dialogue-guard', 'dialogueBeatGuard', Boolean);
    bindSetting('tsf-card-link', 'cardLinkEnabled', Boolean);
    element('tsf-card-link-refresh').addEventListener('click', () => {
        updateUi();
        toastr.info('CardInject 카테고리 목록을 다시 읽었어요.', '🫧또또SFW');
    });
    const dialogueSlider = element('tsf-dialogue-window');
    dialogueSlider.addEventListener('input', () => {
        element('tsf-dialogue-window-value').textContent = `${dialogueSlider.value}개`;
    });
    dialogueSlider.addEventListener('change', () => {
        const settings = getSettings();
        settings.dialogueWindow = Math.min(6, Math.max(1, Number(dialogueSlider.value) || DIALOGUE_BEAT_WINDOW));
        saveSettings();
        updateUi();
    });
    bindSetting('tsf-pace-mode', 'paceMode', String);
    bindSetting('tsf-slow-burn-enabled', 'slowBurnEnabled', Boolean, (settings) => {
        const meta = getChatMeta(false);
        if (!meta) return;
        resetSlowBurnSession(meta);
        saveChatMeta();
        if (settings.slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
    });
    bindSetting('tsf-slow-burn-intensity', 'slowBurnIntensity', String);
    bindSetting('tsf-slow-burn-user-override', 'slowBurnUserOverride', Boolean);
    bindSetting('tsf-style-length', 'styleLength', String);
    bindSetting('tsf-style-balance', 'styleBalance', String);
    bindSetting('tsf-exit-bridge', 'exitBridge', Boolean);
    bindSetting('tsf-auto-refine', 'autoRefine', Boolean);
    bindSetting('tsf-refine-profile', 'refineProfileId', String);

    const slider = element('tsf-repeat-window');
    slider.addEventListener('input', () => {
        element('tsf-repeat-window-value').textContent = `${slider.value}턴`;
    });
    slider.addEventListener('change', () => {
        const settings = getSettings();
        settings.repeatWindow = Math.min(10, Math.max(1, Number(slider.value) || DEFAULT_SETTINGS.repeatWindow));
        saveSettings();
        updateUi();
    });

    const maxBannedSlider = element('tsf-max-banned');
    maxBannedSlider.addEventListener('input', () => {
        element('tsf-max-banned-value').textContent = `${maxBannedSlider.value}개`;
    });
    maxBannedSlider.addEventListener('change', () => {
        const settings = getSettings();
        settings.maxBannedActs = Math.min(30, Math.max(5, Number(maxBannedSlider.value) || DEFAULT_SETTINGS.maxBannedActs));
        saveSettings();
        updateUi();
    });

    element('tsf-chat-enabled').addEventListener('change', () => {
        const meta = getChatMeta();
        const wasEnabled = Boolean(meta.enabled);
        meta.enabled = element('tsf-chat-enabled').checked;
        if (wasEnabled && !meta.enabled) {
            meta.bridgePending = Boolean(getSettings().exitBridge);
            meta.autoArmed = false;
        } else if (meta.enabled) {
            meta.bridgePending = false;
        }
        resetSlowBurnSession(meta);
        saveChatMeta();
        if (!meta.enabled) clearInjectedPrompt();
        else if (getSettings().slowBurnEnabled && isFullyArmed()) startSlowBurnSessionIfNeeded();
        updateUi();
    });

    element('tsf-state-location').addEventListener('change', () => {
        applyManualEdit((draft) => { draft.location = element('tsf-state-location').value; });
    });

    element('tsf-refine').addEventListener('click', () => { void runRefine({ manual: true }); });
    element('tsf-force-arm').addEventListener('click', forceToggleArm);

    const saveSlowBurnTargetDraft = () => {
        const meta = getChatMeta();
        meta.slowBurnTarget = sanitizeSlowBurnTarget(element('tsf-slow-burn-target').value);
        meta.slowBurnTargetTurns = clampSlowBurnTargetTurns(element('tsf-slow-burn-target-turns').value);
        meta.slowBurnTargetCompleted = false;
        saveChatMeta();
        updateUi();
    };
    element('tsf-slow-burn-target').addEventListener('change', saveSlowBurnTargetDraft);
    element('tsf-slow-burn-target-turns').addEventListener('change', saveSlowBurnTargetDraft);
    element('tsf-slow-burn-target').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            element('tsf-slow-burn-target-start').click();
        }
    });
    element('tsf-slow-burn-target-start').addEventListener('click', () => {
        const settings = getSettings();
        const target = sanitizeSlowBurnTarget(element('tsf-slow-burn-target').value);
        const turns = clampSlowBurnTargetTurns(element('tsf-slow-burn-target-turns').value);
        if (!target) {
            toastr.warning('보고 싶은 장면을 먼저 입력해주세요. 예: 화해', '🫧또또SFW');
            element('tsf-slow-burn-target').focus();
            return;
        }
        if (!settings.enabled) {
            toastr.warning('전체 사용을 먼저 켜주세요.', '🫧또또SFW');
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
        meta.autoArmed = true;
        saveChatMeta();
        startSlowBurnSessionIfNeeded();
        toastr.success(`“${target}” 장면을 다음 AI 답변부터 ${turns}회 유지해요.`, '🫧또또SFW');
        updateUi();
    });
    element('tsf-slow-burn-target-stop').addEventListener('click', () => {
        const meta = getChatMeta();
        meta.slowBurnTargetActive = false;
        meta.slowBurnTargetCompleted = false;
        meta.slowBurnRecoveryPending = false;
        saveChatMeta();
        toastr.info('목표 장면 진행을 중지했어요. 기본 슬로우번은 계속 적용돼요.', '🫧또또SFW');
        updateUi();
    });

    const setSlowBurnStage = (offset) => {
        const meta = getChatMeta();
        const current = slowBurnStageInfo().stage;
        meta.slowBurnStageOverride = Math.max(1, Math.min(6, current + offset));
        saveChatMeta();
        updateUi();
    };
    element('tsf-slow-burn-prev').addEventListener('click', () => setSlowBurnStage(-1));
    element('tsf-slow-burn-next').addEventListener('click', () => setSlowBurnStage(1));
    element('tsf-slow-burn-lock').addEventListener('click', () => {
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
    element('tsf-slow-burn-auto').addEventListener('click', () => {
        const meta = getChatMeta();
        meta.slowBurnStageOverride = null;
        meta.slowBurnLocked = false;
        resetSlowBurnSession(meta);
        saveChatMeta();
        updateUi();
    });

    const addGlobalBan = () => {
        const input = element('tsf-global-ban-input');
        const value = input.value.trim();
        if (!value) return;
        const settings = getSettings();
        if (!Array.isArray(settings.globalBans)) settings.globalBans = [];
        if (!settings.globalBans.includes(value)) settings.globalBans.push(value);
        input.value = '';
        saveSettings();
        updateUi();
    };
    element('tsf-global-ban-add').addEventListener('click', addGlobalBan);
    element('tsf-global-ban-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addGlobalBan(); }
    });

    const addCustomBan = () => {
        const input = element('tsf-custom-ban-input');
        const value = input.value.trim();
        if (!value) return;
        const meta = getChatMeta();
        if (!meta.customBans.includes(value)) meta.customBans.push(value);
        input.value = '';
        saveChatMeta();
        updateUi();
    };
    element('tsf-custom-ban-add').addEventListener('click', addCustomBan);
    element('tsf-custom-ban-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addCustomBan(); }
    });

    element('tsf-clear-state').addEventListener('click', () => {
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
        toastr.info('이 채팅의 장면 기록을 비웠어요.', '🫧또또SFW');
        updateUi();
    });

    element('tsf-toggle-preview').addEventListener('click', () => {
        const preview = element('tsf-prompt-preview');
        preview.hidden = !preview.hidden;
        element('tsf-toggle-preview').textContent = preview.hidden ? '주입문 보기' : '주입문 접기';
        updateUi();
    });
}

// ───────────────────────── 팝업 (완드 메뉴 빠른 접근) ─────────────────────────
// 설정 패널 DOM을 통째로 팝업으로 옮겼다가 닫을 때 되돌린다 — 모든 기능·바인딩이 그대로 동작.

function buildPopupShell() {
    if (document.getElementById('tsf-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'tsf-overlay';
    overlay.className = 'tsf-overlay';
    overlay.innerHTML = [
        '<div class="tsf-popup">',
        '  <div class="tsf-popup-header">',
        '    <strong id="tsf-popup-title">🫧 또또SFW</strong>',
        '    <button id="tsf-popup-close" class="menu_button" type="button" title="닫기">✕</button>',
        '  </div>',
        '  <div id="tsf-popup-body" class="tsf-popup-body"></div>',
        '</div>',
    ].join('\n');
    // MovingUI가 body에 transform을 걸어 fixed가 깨지는 문제: 오버레이 자체에 transform 리셋으로 대응 (킨크 추출기와 동일)
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closePopup();
    });
    overlay.querySelector('#tsf-popup-close').addEventListener('click', closePopup);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && popupOpen) closePopup();
    });
}

function openPopup() {
    if (!uiReady) {
        toastr.warning('설정 패널이 아직 준비되지 않았어요. 잠시 후 다시 열어주세요.', '🫧또또SFW');
        return;
    }
    buildPopupShell();
    const panel = document.getElementById('ttotto-sfw-settings');
    const overlay = document.getElementById('tsf-overlay');
    if (!panel || !overlay) return;
    if (!settingsHomeParent) settingsHomeParent = panel.parentElement;
    document.getElementById('tsf-popup-body').append(panel);
    panel.classList.add('tsf-in-popup');
    // 드로어가 접혀 있었어도 팝업에서는 무조건 펼침 (인라인 강제)
    const drawerContent = panel.querySelector('.inline-drawer-content');
    if (drawerContent) drawerContent.style.setProperty('display', 'block', 'important');
    overlay.classList.add('open');
    popupOpen = true;
    updateUi();
}

function closePopup() {
    const overlay = document.getElementById('tsf-overlay');
    const panel = document.getElementById('ttotto-sfw-settings');
    overlay?.classList.remove('open');
    if (panel && settingsHomeParent) {
        panel.classList.remove('tsf-in-popup');
        const drawerContent = panel.querySelector('.inline-drawer-content');
        if (drawerContent) drawerContent.style.removeProperty('display');
        settingsHomeParent.append(panel);
    }
    popupOpen = false;
}

function addWandButton() {
    if (document.getElementById('tsf-wand-button')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        console.warn(`${LOG_PREFIX} #extensionsMenu를 찾지 못했습니다 — ST 버전에 따라 셀렉터 조정이 필요할 수 있어요.`);
        return;
    }
    const item = document.createElement('div');
    item.id = 'tsf-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<span class="extensionsMenuExtensionButton" aria-hidden="true">🫧</span><span>또또SFW</span>';
    item.addEventListener('click', () => {
        menu.style.display = 'none';
        openPopup();
    });
    menu.append(item);
}

function removeWandButton() {
    document.getElementById('tsf-wand-button')?.remove();
}

async function loadSettingsHtml() {
    const response = await fetch(new URL('settings.html', EXTENSION_BASE_URL));
    if (!response.ok) throw new Error(`settings.html 로드 실패 (HTTP ${response.status})`);
    return response.text();
}

async function initializeUi() {
    if (document.getElementById('ttotto-sfw-settings')) return; // 중복 삽입 방지
    const html = await loadSettingsHtml();
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) throw new Error('확장 설정 컨테이너를 찾을 수 없습니다.');
    container.insertAdjacentHTML('beforeend', html);
    const required = [
        'tsf-enabled',
        'tsf-chat-enabled',
        'tsf-repeat-window',
        'tsf-pace-mode',
        'tsf-slow-burn-enabled',
        'tsf-slow-burn-stage',
        'tsf-refine',
        'tsf-state-location',
        'tsf-dialogue-window',
        'tsf-card-link',
        'tsf-card-link-list',
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
    // 스와이프 보험: ST 버전에 따라 스와이프 생성 후 MESSAGE_RECEIVED가 안 오는 경우를 이중으로 잡는다
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
    document.getElementById('tsf-overlay')?.remove();
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
            toastr.error(`초기화 실패: ${error?.message ?? error}`, '🫧또또SFW');
        });
    });
} else {
    void initialize().catch((error) => console.error(`${LOG_PREFIX} 초기화 실패`, error));
}
