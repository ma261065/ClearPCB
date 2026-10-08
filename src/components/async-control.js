/**
 * Creates a generation gate used to discard stale async results.
 * @returns {{next: () => number, invalidate: () => void, isCurrent: (token: number) => boolean}}
 */
export function createGenerationGate() {
    let generation = 0;

    return {
        next() {
            generation += 1;
            return generation;
        },
        invalidate() {
            generation += 1;
        },
        isCurrent(token) {
            return generation === token;
        }
    };
}

/**
 * @template {unknown[]} A
 * @typedef {{run: (...args: A) => void, cancel: () => void, dispose: () => void}} DebouncedRunner
 */

/**
 * Creates a debounced function runner.
 * @template {unknown[]} A
 * @param {number} delayMs - Debounce delay in milliseconds.
 * @param {(...args: A) => void} callback - Function invoked after debounce delay.
 * @returns {DebouncedRunner<A>}
 */
export function createDebouncedRunner(delayMs, callback) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;

    const cancel = () => {
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        timer = null;
    };

    return {
        run(...args) {
            cancel();
            timer = setTimeout(() => {
                timer = null;
                callback(...args);
            }, delayMs);
        },
        cancel,
        dispose: cancel
    };
}
