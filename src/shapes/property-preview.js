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
    const binding = {
        committing: false,
        get active() { return !!active?.active; },
        get disposed() { return disposed; },
        activate(preview) {
            if (disposed) return false;
            if (active && active !== preview) active.commit({ rebuild: false });
            binding.committing = true;
            try { beforeActivate(); } finally { binding.committing = false; }
            if (disposed) return false;
            active = preview;
            return true;
        },
        release(preview) { if (active === preview) active = null; },
        commit(options) { return active?.commit(options) || false; },
        cancel() { return active?.cancel() || false; },
        prepare() {
            if (disposed) return false;
            active?.commit({ rebuild: false });
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

export function commitPropertyPreviewInput(input, preview, {
    forceRebuild = false, isCurrent = () => true,
    commit = options => preview.commit(options), refresh = () => {},
} = {}) {
    const current = isCurrent();
    if (!current && !preview.active) return false;
    const changed = Number.isFinite(parseFloat(input.value))
        ? commit({ rebuild: current && (forceRebuild || document.activeElement !== input) })
        : preview.cancel();
    if (current) refresh();
    return changed;
}

export function bindPropertyPreviewInput(input, preview, {
    isCurrent = () => true, commit = options => preview.commit(options),
    refresh = () => {}, onCancel = refresh,
} = {}) {
    input?.addEventListener('keydown', event => {
        if (!isCurrent() || event.key !== 'Escape' || !preview.cancel()) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
    });
    input?.addEventListener('blur', () => {
        queueMicrotask(() => {
            if (preview.active) commitPropertyPreviewInput(input, preview, { isCurrent, commit, refresh });
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