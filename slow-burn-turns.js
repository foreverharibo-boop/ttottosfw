// Logical reply slots, not request counts. No message or body writes.
// A regenerated reply retains its preceding user turn even when ST replaces
// the assistant object, timestamps and swipe metadata.
function fingerprint(value) {
    let a = 2166136261, b = 2246822507;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        a = Math.imul(a ^ code, 16777619);
        b = Math.imul(b ^ code, 3266489909);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export function replySlots(chat, isPending = () => false) {
    const slots = [], occurrences = new Map();
    let anchor = 'root', position = 0, assistantIndex = 0;
    for (const message of Array.isArray(chat) ? chat : []) {
        if (!message || message.is_system) continue;
        if (message.is_user) {
            const date = message.send_date;
            // Native user timestamps survive edits, reloads and branch copies.
            // Imported messages without dates use a deterministic fallback.
            const value = date !== undefined && date !== null && date !== ''
                ? 'date:' + String(date) : 'text:' + String(message.mes ?? '');
            const id = fingerprint(value), occurrence = occurrences.get(id) ?? 0;
            occurrences.set(id, occurrence + 1);
            anchor = `${id}:${occurrence}`; position = 0;
            continue;
        }
        const key = `${anchor}:${position++}`;
        const complete = !isPending(message) && Boolean(String(message.mes ?? '').trim())
            && (!message.gen_started || Boolean(message.gen_finished));
        slots.push({ key, message, complete, assistantIndex: assistantIndex++ });
    }
    return slots;
}

export function beginTurnSession(chat, isPending) {
    return { version: 1, baseline: replySlots(chat, isPending).filter(slot => slot.complete).map(slot => slot.key).join('\n') };
}

export function sessionTurns(meta, chat, isPending) {
    if (!meta?.slowBurnSessionActive) return { messages: [], baselineTurns: 0, legacyRebased: false, changed: false };
    const slots = replySlots(chat, isPending);
    let session = meta.slowBurnTurnSession, changed = false;
    if (session?.version !== 1 || typeof session.baseline !== 'string') {
        const old = meta.slowBurnSessionStartAssistantCount;
        const valid = Number.isInteger(old) && old >= 0;
        const boundary = valid ? Math.min(old, slots.length) : slots.length;
        session = { version: 1, baseline: slots.filter(slot => slot.complete && slot.assistantIndex < boundary).map(slot => slot.key).join('\n'),
            legacyRebased: !valid || old > slots.length };
        meta.slowBurnTurnSession = session;
        changed = true;
    }
    const baseline = new Set(session.baseline ? session.baseline.split('\n') : []);
    return { messages: slots.filter(slot => slot.complete && !baseline.has(slot.key)).map(slot => slot.message),
        baselineTurns: baseline.size, legacyRebased: !!session.legacyRebased, changed };
}
