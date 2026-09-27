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

export function createPropertyPreview({ capture, restore, redraw, commit }) {
    for (const method of [capture, restore, redraw, commit]) {
        if (typeof method !== 'function') throw new TypeError('Incomplete property preview transaction');
    }
    let before;
    let active = false;
    return {
        get active() { return active; },
        begin() {
            if (!active) {
                before = capture();
                active = true;
            }
            return before;
        },
        update(mutate) {
            const original = this.begin();
            mutate(original);
            redraw('preview');
        },
        commit() {
            if (!active) return false;
            const after = capture();
            const original = before;
            restore(original);
            before = undefined;
            active = false;
            if (JSON.stringify(original) === JSON.stringify(after)) {
                redraw('commit');
                return false;
            }
            commit(original, after);
            redraw('commit');
            return true;
        },
        cancel() {
            if (!active) return false;
            restore(before);
            before = undefined;
            active = false;
            redraw('cancel');
            return true;
        },
    };
}