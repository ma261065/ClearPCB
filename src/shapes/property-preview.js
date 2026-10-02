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
    for (const target of changed) adapter.prepare(target);
    adapter.render(changed);
    adapter.refreshSelection();
    adapter.refreshDerived();
}

export function createPropertyBinding({ beforeActivate = () => {}, onDispose = () => {} } = {}) {
    let disposed = false;
    let active = null;
    const completions = new WeakMap();
    const finish = (preview, options) => {
        if (!preview) return false;
        const complete = completions.get(preview);
        return complete ? complete(options) : preview.commit(options);
    };
    const binding = {
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
    };
    return binding;
}

/**
 * @param {HTMLInputElement|null} input
 * @param {any} preview
 * @param {{forceRebuild?: boolean, isCurrent?: () => boolean, focusRoot?: Element|null,
 *   commit?: (options: any) => boolean, refresh?: () => void}} [options]
 */
export function commitPropertyPreviewInput(input, preview, {
    forceRebuild = false, isCurrent = () => true, focusRoot = null,
    commit = options => preview.commit(options), refresh = () => {},
} = {}) {
    const current = isCurrent();
    if (!current && !preview.active) return false;
    const keepFocus = document.activeElement === input || focusRoot?.contains?.(document.activeElement);
    const changed = Number.isFinite(parseFloat(input.value))
        ? commit({ rebuild: current && (forceRebuild || !keepFocus) })
        : preview.cancel();
    if (current) refresh();
    return changed;
}

/**
 * @param {HTMLInputElement|null} input
 * @param {any} preview
 * @param {{binding?: any, isCurrent?: () => boolean, focusRoot?: Element|null,
 *   commit?: (options: any) => boolean, refresh?: () => void, onCancel?: () => void}} [options]
 */
export function bindPropertyPreviewInput(input, preview, {
    binding = null, isCurrent = () => true, focusRoot = null, commit = options => preview.commit(options),
    refresh = () => {}, onCancel = refresh,
} = {}) {
    const finish = options => commitPropertyPreviewInput(input, preview, {
        isCurrent, focusRoot, refresh, commit: settings => commit({ ...settings, ...options }),
    });
    if (input) binding?.registerCompletion(preview, finish);
    input?.addEventListener('keydown', event => {
        if (!isCurrent() || event.key !== 'Escape' || !preview.cancel()) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
    });
    input?.addEventListener('blur', () => {
        queueMicrotask(() => {
            if (preview.active) finish();
        });
    });
}

export function createPropertyPreview({
    capture, restore, redraw, commit, binding = null, isCurrent = () => true, beforeCommit = () => {},
}) {
    for (const method of [capture, restore, redraw, commit]) {
        if (typeof method !== 'function') throw new TypeError('Incomplete property preview transaction');
    }
    let before;
    let active = false;
    const control = {
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
        commit(options) {
            if (!active) return false;
            beforeCommit();
            const after = capture();
            const original = before;
            restore(original);
            before = undefined;
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
            before = undefined;
            active = false;
            binding?.release(control);
            redraw('cancel');
            return true;
        },
    };
    return control;
}