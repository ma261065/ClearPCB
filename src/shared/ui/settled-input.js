/**
 * Commit a number field once its value settles. Every spinner click fires `change`,
 * and commits are expensive (a history entry, and a pour, DRC and 3D refresh), so a
 * run of clicks commits once: after a quiet period, or at once on Enter or when the
 * field loses focus. A field that has been removed (the panel was rebuilt) drops
 * its pending value.
 *
 * Live-preview fields keep showing the new value while it settles; their `change`
 * handler previews and this helper commits. Undo, save and export call
 * flushSettledChanges first, so a run in progress is never lost or refused.
 */
export const SETTLE_MS = 400;

/** Flushes of the fields that have a commit waiting to settle. */
const pending = new Set();

/**
 * @param {HTMLInputElement} input
 * @param {() => void} commit reads the input's current value
 * @param {number} [settleMs]
 * @returns {{flush: () => void, cancel: () => void}}
 */
export function bindSettledChange(input, commit, settleMs = SETTLE_MS) {
    let timer = 0;
    const cancel = () => {
        clearTimeout(timer);
        timer = 0;
        pending.delete(flush);
    };
    const run = () => {
        cancel();
        if (input.isConnected !== false) commit();
    };
    function flush() { if (timer) run(); }
    input.addEventListener('change', () => {
        clearTimeout(timer);
        timer = setTimeout(run, settleMs);
        pending.add(flush);
    });
    // After blur, so a commit sees which control (if any) took focus.
    input.addEventListener('blur', () => queueMicrotask(flush));
    // Enter's keydown comes before its `change`, so commit the current value now.
    input.addEventListener('keydown', event => { if (event.key === 'Enter') run(); });
    return { flush, cancel };
}

/** Commit every field still waiting to settle, before anything reads the model. */
export function flushSettledChanges() {
    for (const flush of [...pending]) flush();
}
