// Only collected state fields grow; custom prompts and other editors are unchanged.
const sceneFieldSizes = new WeakMap();
const observedSceneFields = new Set();
let sceneFieldObserver = null;
let sceneFieldResizeBound = false;
export function resizeSceneField(field) {
    if (!field?.getClientRects?.().length || !field.clientWidth) {
        if (field) sceneFieldSizes.set(field, 0);
        return;
    }
    const style = globalThis.getComputedStyle?.(field);
    const border = (parseFloat(style?.borderTopWidth) || 0) + (parseFloat(style?.borderBottomWidth) || 0);
    const previous = field.style.height;
    // Preserve the page's scroll anchor while measuring a potentially shorter value.
    const parent = field.parentElement;
    const minHeight = parent?.style.minHeight;
    if (parent) parent.style.minHeight = `${parent.getBoundingClientRect().height}px`;
    field.style.height = 'auto';
    const height = `${Math.ceil(field.scrollHeight + border)}px`;
    field.style.height = height;
    if (parent) parent.style.minHeight = minHeight;
    sceneFieldSizes.set(field, field.clientWidth);
    return height !== previous;
}
export function autoSizeSceneFields(root = document) {
    if (!root?.querySelectorAll) return;
    if (!sceneFieldObserver && typeof ResizeObserver !== 'undefined') {
        sceneFieldObserver = new ResizeObserver(entries => {
            for (const { target } of entries) {
                if (!target.getClientRects().length || sceneFieldSizes.get(target) !== target.clientWidth) resizeSceneField(target);
            }
        });
    }
    if (!sceneFieldResizeBound) {
        globalThis.addEventListener?.('resize', () => autoSizeSceneFields());
        sceneFieldResizeBound = true;
    }
    for (const old of observedSceneFields) if (!old.isConnected) {
        sceneFieldObserver?.unobserve(old); observedSceneFields.delete(old);
    }
    for (const field of root.querySelectorAll('textarea.ttotto-scene-textarea')) {
        if (!observedSceneFields.has(field)) {
            observedSceneFields.add(field);
            field.addEventListener('input', () => resizeSceneField(field));
            sceneFieldObserver?.observe(field);
        }
        resizeSceneField(field);
    }
}
