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
 * Creates a debounced function runner.
 * @param {number} delayMs - Debounce delay in milliseconds.
 * @param {Function} callback - Function invoked after debounce delay.
 * @returns {{run: (...args: any[]) => void, cancel: () => void, dispose: () => void}}
 */
export function createDebouncedRunner(delayMs, callback) {
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
