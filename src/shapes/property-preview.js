/** @typedef {any[]} PropertyPreviewState Preview snapshots mix shape states and primitive property values. */
/** @typedef {{rebuild?: boolean}} PropertyCommitOptions */
/** @typedef {{active?: boolean, begin?: Function, update: Function, commit: (options?: PropertyCommitOptions) => boolean, cancel: () => boolean, [key: string]: unknown}} PropertyPreview */
/** @typedef {{committing: boolean, active: boolean, disposed: boolean, registerCompletion: (preview: PropertyPreview, complete: (options?: PropertyCommitOptions) => boolean) => void, activate: (preview: PropertyPreview) => boolean, release: (preview: PropertyPreview) => void, commit: (options?: PropertyCommitOptions) => boolean, cancel: () => boolean, prepare: () => boolean, dispose: () => void, [key: string]: unknown}} PropertyBinding */
/** @typedef {{capture: () => PropertyPreviewState, restore: (state: PropertyPreviewState) => void, redraw: (phase: string) => void, commit: (before: PropertyPreviewState, after: PropertyPreviewState, options?: PropertyCommitOptions) => void, binding?: PropertyBinding|null, isCurrent?: () => boolean, beforeCommit?: () => void}} PropertyPreviewOptions */
/**
 * @template Target
 * @typedef {{renderScene?: (targets: Target[]) => void, prepare?: (target: Target) => void, render?: (targets: Target[]) => void, refreshSelection?: () => void, refreshDerived?: () => void, [key: string]: unknown}} PropertyPreviewAdapter<Target>
 */

/** @template Target @param {Target[]} targets @param {PropertyPreviewAdapter<Target>} adapter */
export function redrawPropertyPreview(targets, adapter) {
    const changed = [...new Set(targets)];
    if (!changed.length) return;
    if (typeof adapter.renderScene === 'function') {
        adapter.renderScene(changed);
        return;
    }
    for (const method of ['prepare', 'render', 'refreshSelection', 'refreshDerived']) {
        if (typeof adapter[method] !== 'function') throw new TypeError(`Property preview requires ${method}`);
    }
    const renderer = /** @type {Required<Pick<PropertyPreviewAdapter<Target>, 'prepare'|'render'|'refreshSelection'|'refreshDerived'>>} */ (adapter);
    for (const target of changed) renderer.prepare(target);
    renderer.render(changed);
    renderer.refreshSelection();
    renderer.refreshDerived();
}

/** @param {{beforeActivate?: () => void, onDispose?: () => void}} [options] @returns {PropertyBinding} */
export function createPropertyBinding({ beforeActivate = () => {}, onDispose = () => {} } = {}) {
    let disposed = false;
    /** @type {PropertyPreview|null} */
    let active = null;
    /** @type {WeakMap<PropertyPreview, (options?: PropertyCommitOptions) => boolean>} */
    const completions = new WeakMap();
    /** @param {PropertyPreview|null} preview @param {PropertyCommitOptions} [options] */
    const finish = (preview, options) => {
        if (!preview) return false;
        const complete = completions.get(preview);
        return complete ? complete(options) : preview.commit(options);
    };
    const binding = /** @type {PropertyBinding} */ ({
        committing: false,
        get active() { return !!active?.active; },
        get disposed() { return disposed; },
        registerCompletion(preview, complete) { completions.set(preview, complete); },
        activate(preview) {
            if (disposed) return false;
            if (active && active !== preview) finish(active, { rebuild: false });
            if (disposed) return false;
            binding.committing = true;
            try { beforeActivate(); } finally { binding.committing = false; }
            if (disposed) return false;
            active = preview;
            return true;
        },
        release(preview) { if (active === preview) active = null; },
        /** @param {PropertyCommitOptions} [options] */
        commit(options) { return finish(active, options) || false; },
        cancel() { return active?.cancel() || false; },
        prepare() {
            if (disposed) return false;
            finish(active, { rebuild: false });
            return !disposed;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            active?.cancel();
            onDispose();
        },
    });
    return binding;
}

/**
 * @param {PropertyPreviewOptions} options
 * @returns {PropertyPreview & {begin: () => PropertyPreviewState, update: (mutate: (state: PropertyPreviewState) => void) => void}}
 */
export function createPropertyPreview({
    capture, restore, redraw, commit, binding = null, isCurrent = () => true, beforeCommit = () => {},
}) {
    for (const method of [capture, restore, redraw, commit]) {
        if (typeof method !== 'function') throw new TypeError('Incomplete property preview transaction');
    }
    /** @type {PropertyPreviewState} */
    let before;
    let active = false;
    const control = /** @type {PropertyPreview & {begin: () => PropertyPreviewState, update: (mutate: (state: PropertyPreviewState) => void) => void}} */ ({
        get active() { return active; },
        begin() {
            if (!active) {
                before = capture();
                active = true;
            }
            return before;
        },
        update(mutate) {
            if (!isCurrent() || binding && !binding.activate(control)) return;
            if (!isCurrent()) { binding?.release(control); return; }
            const original = this.begin();
            mutate(original);
            redraw('preview');
        },
        /** @param {PropertyCommitOptions} [options] */
        commit(options) {
            if (!active) return false;
            beforeCommit();
            const after = capture();
            const original = before;
            restore(original);
            before = [];
            active = false;
            binding?.release(control);
            if (JSON.stringify(original) === JSON.stringify(after)) {
                redraw('commit');
                return false;
            }
            commit(original, after, options);
            redraw('commit');
            return true;
        },
        cancel() {
            if (!active) return false;
            restore(before);
            before = [];
            active = false;
            binding?.release(control);
            redraw('cancel');
            return true;
        },
    });
    return control;
}