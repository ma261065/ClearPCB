export function attachPropertyPanelHarness(app, { controls = new Map(), actions = new Map() } = {}) {
    const fieldById = id => app._propertyPanel?.fields.find(field => field.id === id || field.key === id) || null;
    const sync = panel => {
        app._propertyPanel = panel;
        for (const field of panel.fields || []) {
            const id = field.id || field.key;
            let control = controls.get(id);
            if (!control) controls.set(id, control = new PanelControl(id));
            control.field = field;
            control.type = field.type;
            control.disabled = !!field.disabled;
            if (field.type === 'checkbox') {
                control.checked = !field.mixed && !!field.value;
                control.indeterminate = !!field.mixed;
            } else if (field.type === 'readout') {
                control.textContent = field.mixed ? 'Mixed' : String(field.value ?? '');
            } else {
                control.value = field.mixed ? '' : String(field.value ?? '');
            }
        }
        actions.clear();
        for (const group of panel.actions || []) {
            for (const action of group.actions || []) {
                const button = new PanelAction(action.id);
                actions.set(action.id, button);
                button.action = action;
                button.disabled = !!action.disabled;
                button.title = action.title || '';
                button.textContent = action.label;
            }
        }
    };
    app.openPropertyPanel = panel => {
        app.setPropertiesTitle?.(panel.title);
        sync(panel);
        return true;
    };
    app.refreshPropertyPanel = panel => sync(panel);
    return {
        controls,
        actions,
        field: fieldById,
        control: id => controls.get(id) || null,
        action: id => actions.get(id) || null,
    };
}

class PanelControl {
    constructor(id) {
        this.id = id;
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.indeterminate = false;
        this.textContent = '';
        this.field = null;
    }

    fire(type, value, extra = {}) {
        if (value !== undefined) this.value = String(value);
        if (this.disabled) return;
        const field = this.field;
        if (!field) return;
        if (type === 'keydown') {
            if (extra.key === 'Escape') field.cancel?.();
            else if (extra.key === 'Enter') field.commit?.();
            return;
        }
        if (field.type === 'checkbox') {
            if (type === 'change') field.commit?.(this.checked);
            return;
        }
        if (field.type === 'select' || field.type === 'text' || field.type === 'net') {
            if (type === 'change') field.commit?.(this.value);
            return;
        }
        if (field.type !== 'number' || !['input', 'change'].includes(type)) return;
        let parsed = field.parse ? field.parse(this.value) : (this.value.trim() === '' ? NaN : Number(this.value));
        if (Number.isFinite(parsed) && field.normalize) {
            parsed = field.normalize(parsed);
            this.value = String(parsed);
        }
        if (Number.isFinite(parsed)) {
            field.preview?.(parsed);
            if (type === 'change') field.commit?.(parsed);
        } else if (type === 'change') {
            field.cancel?.();
            this.value = field.mixed ? '' : String(field.value ?? '');
        }
    }
}

class PanelAction {
    constructor(id) {
        this.id = id;
        this.disabled = false;
        this.textContent = '';
        this.title = '';
        this.action = null;
    }

    fire(type) {
        if (type === 'click' && !this.disabled) this.action?.run();
    }
}
