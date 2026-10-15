// Recount only messages whose owned scene reports were removed in this session.
// No generation, translation, full-message rendering, or provider usage changes.
export function createBodyTokenCounter({ raw, ready, allowed, epoch, swipe, save, record = () => {} }) {
    let tracked = new WeakSet(), jobs = new WeakMap(), revision = 0;
    const chatId = context => context.getCurrentChatId?.() ?? context.chatId;
    const enabled = context => context.powerUserSettings?.message_token_count_enabled !== false;
    function valid(job) {
        const context = raw();
        return ready() && allowed() && enabled(context) && revision === job.revision
            && epoch() === job.epoch && context.chat === job.chat && context.chatMetadata === job.metadata
            && chatId(context) === job.chatId && context.chat[job.index] === job.message
            && swipe(job.message) === job.swipe && job.message.mes === job.text
            && job.message.extra === job.extra && jobs.get(job.message) === job;
    }
    function apply(job) {
        if (!valid(job)) return;
        const message = job.message;
        let changed = message.extra.token_count !== job.count;
        if (changed) message.extra.token_count = job.count;
        // Never update another swipe or replace its other metadata.
        const info = message.swipe_info?.[job.swipe];
        if (info && message.swipes?.[job.swipe] === job.text) {
            info.extra ??= {};
            if (info.extra.token_count !== job.count) { changed = true; info.extra.token_count = job.count; }
        }
        // Change the counter alone: rerendering the reply can disturb translation UI.
        const element = globalThis.document?.querySelector?.(`#chat .mes[mesid="${job.index}"]`);
        const displayedSwipe = element?.getAttribute('swipeid');
        if (element && (displayedSwipe == null || displayedSwipe === String(job.swipe))) {
            for (const counter of element.querySelectorAll('.tokenCounterDisplay')) {
                const label = `${job.count}t`;
                if (counter.textContent !== label) counter.textContent = label;
            }
        }
        if (changed) {
            record('body_token_count_updated', { message: job.index, swipe: job.swipe, bodyChars: job.text.length, tokens: job.count });
            save();
        }
    }
    function refresh(message) {
        if (!message || !tracked.has(message) || !ready() || !allowed()) return;
        const context = raw();
        if (!enabled(context) || typeof context.getTokenCountAsync !== 'function' || !message.extra) return;
        const index = context.chat.indexOf(message);
        if (index < 0 || typeof message.mes !== 'string') return;
        const previous = jobs.get(message);
        if (previous && valid(previous)) {
            if (previous.count !== undefined) apply(previous);
            return;
        }
        const job = { message, text: message.mes, swipe: swipe(message), extra: message.extra,
            index, chat: context.chat, metadata: context.chatMetadata, chatId: chatId(context),
            epoch: epoch(), revision };
        jobs.set(message, job);
        Promise.resolve().then(() => {
            if (!valid(job)) return undefined;
            return context.getTokenCountAsync(job.text, 0);
        }).then(count => {
            if (!valid(job)) return;
            if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid token count');
            job.count = count;
            apply(job);
        }).catch(() => {
            if (jobs.get(message) !== job) return;
            const current = valid(job);
            jobs.delete(message);
            // Keep the old count on failure; omit response text and exception contents.
            if (current) record('body_token_count_failed', { message: job.index, swipe: job.swipe });
        });
    }
    return {
        cleaned(message) { tracked.add(message); refresh(message); },
        refresh,
        reset() { revision++; tracked = new WeakSet(); jobs = new WeakMap(); },
    };
}
