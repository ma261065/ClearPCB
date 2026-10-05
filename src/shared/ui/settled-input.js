/**
 * Commit a number field once its value settles. Every spinner click fires `change`,
 * and some commits are expensive (a pour edit recomputes the copper), so a run of
 * clicks commits once: after a quiet period, or at once on Enter or when the field
 * loses focus. A field that has been removed (the panel was rebuilt) drops its
 * pending value.
 */
export const SETTLE_MS = 400;

/**
 * @param {HTMLInputElement} input
 * @param {() => void} commit reads the input's current value
 * @param {number} [settleMs]
 * @returns {{flush: () => void, cancel: () => void}}
 */
export function bindSettledChange(input, commit, settleMs = SETTLE_MS) {
    let timer = 0;
    const run = () => {
        clearTimeout(timer);
        timer = 0;
        if (input.isConnected !== false) commit();
    };
    const flush = () => { if (timer) run(); };
    input.addEventListener('change', () => {
        clearTimeout(timer);
        timer = setTimeout(run, settleMs);
    });
    input.addEventListener('blur', flush);
    // Enter's keydown comes before its `change`, so commit the current value now.
    input.addEventListener('keydown', event => { if (event.key === 'Enter') run(); });
    return { flush, cancel: () => { clearTimeout(timer); timer = 0; } };
}
