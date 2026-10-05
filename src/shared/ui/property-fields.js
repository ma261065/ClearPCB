/**
 * Properties panels: the boundary between what a panel edits and how it looks.
 *
 * A panel module (logic) describes itself as a PropertyPanel: a title, fields
 * (key, type, label, value, mixed/disabled state, limits, options) with edit hooks,
 * and action groups. It never touches the DOM. An editor's host shows the
 * description; this module is the one place that turns descriptions into controls,
 * so a new look (e.g. a redesigned ribbon) changes only the renderer and hosts.
 *
 * Panels re-describe themselves after any change and the renderer reconciles rows by
 * key, updating them in place: a focused control keeps its focus and the value being
 * typed, so a panel never patches controls (dynamic limits are just new descriptions).
 *
 * Edit protocol, the same for every panel in both editors:
 * - number: `input` and `change` call `preview(value)` (live); the run commits once
 *   settled (shared/ui/settled-input.js) with `commit(value)`, or at once on Enter or
 *   blur. An unparsable value calls `cancel()` and restores the field. Escape calls
 *   `cancel()`; when it returns true the key is consumed and the field restored.
 * - select, checkbox, text, net: `commit(value)` on change (net also from its menu).
 * - readout: a display-only value. Actions: `run()` on click.
 *
 * Mixed values (the selected objects disagree) show an empty field with a `Mixed`
 * placeholder, a disabled `Mixed` select option or an indeterminate checkbox; disabled
 * fields (locked object or layer) use the native `disabled` attribute.
 */
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { sortByPropertyOrder } from './property-order.js';
import { bindSettledChange } from './settled-input.js';

export const MIXED_LABEL = 'Mixed';

/**
 * @typedef {{value: string, label: string, disabled?: boolean, title?: string,
 *   dataset?: Record<string, string>}} PropertyOption
 *
 * @typedef {object} PropertyField
 * @property {string} key Unique within the panel; also the order key unless `prop` is given.
 * @property {'number'|'select'|'checkbox'|'text'|'net'|'readout'} type
 * @property {string} label
 * @property {string} [prop] Canonical order key (shared/ui/property-order.js) when it differs from `key`.
 * @property {string} [id] Stable control id (tests, labels).
 * @property {any} [value] Current value (ignored when `mixed`).
 * @property {boolean} [mixed]
 * @property {boolean} [disabled]
 * @property {string} [placeholder] Shown for an empty text/net value; net defaults to `None`.
 * @property {string} [title] Tooltip.
 * @property {string} [error] Validation message shown by native controls.
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {'rotation'|'precise'|string} [numberFormat] Display hint for core/number-inputs.js.
 * @property {(value: any) => string} [format] Number display; default two decimals, as every
 *   number input, unless `numberFormat` is rotation, precise or integer.
 * @property {(text: string) => number} [parse] Number parse; NaN is invalid. Default Number (blank is NaN).
 * @property {() => number} [seedMixed] Number used when a mixed/blank number starts a spinner or Arrow-key step.
 * @property {boolean} [formatStepped] Format spinner/Arrow-key values with `format`.
 * @property {PropertyOption[]} [options] Select options.
 * @property {string[]} [nets] Net menu entries (the empty net is listed first).
 * @property {(value: number) => number} [normalize] Number clamp/wrap applied to an entry
 *   before preview and commit; the field then shows the normalized value. NaN rejects it.
 * @property {(value: number) => void} [preview] Number live preview.
 * @property {(value: any) => void} [commit]
 * @property {() => boolean|void} [cancel] Escape or an invalid entry; true when something was undone.
 * @property {{begin: () => void, end: () => void}} [hold] Pressing and holding the
 *   control (a spinner run): begin on press, end on release.
 *
 * @typedef {{id: string, label: string, title?: string, disabled?: boolean, run: () => void}} PropertyAction
 * @typedef {{title: string, actions: PropertyAction[]}} PropertyActionGroup
 *
 * @typedef {object} PropertyPanel
 * @property {string} title
 * @property {PropertyField[]} fields Shown in the canonical property order (by `prop` or `key`);
 *   fields that rank equally keep the order given.
 * @property {string} [summary] A line above the fields (e.g. "3 selected").
 * @property {string} [placeholder] Shown when there are no fields.
 * @property {PropertyActionGroup[]} [actions]
 */

const element = (tag, className = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
};

const isFocused = control => typeof document !== 'undefined' && document.activeElement === control;

/** Number formats that keep their own digits (core/number-inputs.js leaves them too). */
const OWN_DIGITS = new Set(['rotation', 'precise', 'integer']);

/**
 * A value as its control shows it. Number fields show two decimals like every number
 * input (core/number-inputs.js), unless their `numberFormat` keeps its own digits;
 * other numbers drop floating-point noise (15.239999999999998 reads 15.24).
 */
const display = (field, value) => {
    if (value === '' || value == null || Number.isNaN(value)) return '';
    if (field.format) return String(field.format(value));
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
    if (field.type === 'number' && !OWN_DIGITS.has(field.numberFormat)) return formatNumberInputValue(value);
    return String(Number(value.toPrecision(12)));
};

const setAttr = (node, name, value) => {
    if (value === undefined || value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
        node.removeAttribute(name);
    } else node.setAttribute(name, String(value));
};

/**
 * One rendered row. `field` is replaced on each reconcile, and every listener reads
 * the current one, so hooks always belong to the latest description.
 */
class Row {
    /** @param {PropertyField} field */
    constructor(field) {
        this.field = field;
        this.row = element('div', 'prop-row');
        this.label = element('label');
        /** @type {any} */
        this.control = null;
        /** The user changed the control since its last commit, cancel or restore. */
        this.dirty = false;
        /** A number edit is waiting to commit (or cancel, when invalid). */
        this.pending = false;
        /** The last number value committed. */
        this.committed = NaN;
        this.build();
        this.update(field, true);
    }

    get key() { return this.field.key; }

    build() {
        const { type } = this.field;
        const row = this.row;
        if (type === 'checkbox') {
            this.row = element('label', 'prop-row prop-toggle');
            this.control = element('input');
            this.control.type = 'checkbox';
            this.text = element('span');
            this.row.append(this.control, this.text);
            this.control.addEventListener('change', () => this.field.commit?.(this.control.checked));
            return;
        }
        if (type === 'readout') {
            this.control = element('span', 'prop-value');
            row.append(this.label, this.control);
            return;
        }
        if (type === 'select') {
            this.control = element('select');
            this.control.addEventListener('change', () => this.field.commit?.(this.control.value));
        } else if (type === 'number') {
            this.buildNumber();
        } else if (type === 'text' || type === 'net') {
            this.control = element('input');
            this.control.type = 'text';
            this.control.addEventListener('input', () => { this.dirty = true; });
            this.control.addEventListener('change', () => {
                this.dirty = false;
                this.field.commit?.(type === 'net' ? this.control.value.trim() : this.control.value);
            });
        } else {
            throw new Error(`Unknown property field type: ${type}`);
        }
        if (type === 'net') {
            this.netControl = element('span', 'prop-net-control');
            this.netControl.appendChild(this.control);
            row.append(this.label, this.netControl);
        } else row.append(this.label, this.control);
        if (type === 'number') this.bindHold();
    }

    /**
     * A held spinner (pointer on its arrows, or a held Arrow key) calls `hold.begin()`,
     * and its release anywhere calls `hold.end()`.
     */
    bindHold() {
        const begin = event => {
            if (event.repeat) return;
            const pointer = event.type === 'pointerdown';
            if (pointer ? event.button !== 0 : !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            this.release?.();
            this.seedMixedNumber();
            this.steppingNumber = true;
            const hold = this.field.hold;
            const host = window;
            const endings = pointer ? ['pointerup', 'pointercancel', 'blur'] : ['keyup', 'blur'];
            const release = endEvent => {
                if (endEvent && endEvent.type !== 'blur'
                    && (pointer ? endEvent.pointerId !== event.pointerId : endEvent.key !== event.key)) return;
                for (const name of endings) host.removeEventListener(name, release, true);
                if (this.release === release) this.release = null;
                this.steppingNumber = false;
                hold?.end();
            };
            this.release = release;
            hold?.begin();
            for (const name of endings) host.addEventListener(name, release, true);
        };
        this.control.addEventListener('pointerdown', begin);
        this.control.addEventListener('keydown', begin);
    }

    seedMixedNumber() {
        if (!this.field.mixed || !this.field.seedMixed || (String(this.control.value || '').trim() !== ''
            && Number.isFinite(this.control.valueAsNumber))) return;
        const seed = this.field.seedMixed();
        if (Number.isFinite(seed)) this.control.value = display(this.field, seed);
    }

    buildNumber() {
        const input = this.control = element('input');
        input.type = 'number';
        // A normalized value (clamped, wrapped) replaces what was entered.
        const parse = () => {
            const value = this.field.parse ? this.field.parse(input.value)
                : (input.value.trim() === '' ? NaN : Number(input.value));
            if (!Number.isFinite(value) || !this.field.normalize) return value;
            const normalized = this.field.normalize(value);
            // Float noise from the arithmetic is not a change to show.
            if (Number.isFinite(normalized) && Math.abs(normalized - value) > 1e-9) input.value = display(this.field, normalized);
            return normalized;
        };
        const preview = event => {
            // Text the renderer showed (not typed or stepped) is not an edit, as in a browser.
            if (input.value === this.shown) return;
            const value = parse();
            // The change that follows an Enter commit repeats the committed value.
            if (event?.type === 'change' && !this.pending && value === this.committed) return;
            this.dirty = true;
            this.pending = true;
            if (Number.isFinite(value)) {
                this.invalidNumberCanceled = false;
                if (this.steppingNumber && this.field.formatStepped) input.value = display(this.field, value);
                this.field.preview?.(value);
            } else if (this.field.cancel?.()) {
                this.invalidNumberCanceled = true;
            }
        };
        input.addEventListener('input', preview);
        input.addEventListener('change', preview);
        // One commit per edit: settling, Enter and blur may all ask; only a pending edit commits.
        const commitCurrent = () => {
            if (!this.pending) return;
            this.pending = false;
            const value = parse();
            this.dirty = false;
            this.committed = value;
            if (Number.isFinite(value)) this.field.commit?.(value);
            else {
                if (!this.invalidNumberCanceled) this.field.cancel?.();
                this.invalidNumberCanceled = false;
                this.restore();
            }
        };
        bindSettledChange(input, commitCurrent);
        input.addEventListener('blur', commitCurrent);
        input.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key)) this.steppingNumber = false;
            if (event.key !== 'Escape' || !this.field.cancel?.()) return;
            this.pending = false;
            this.restore();
            event.preventDefault();
            event.stopPropagation();
        });
    }

    restore() {
        this.dirty = false;
        this.show(this.field.mixed ? '' : display(this.field, this.field.value));
    }

    /** Write text into the control, remembering it as the renderer's own. */
    show(text) {
        this.control.value = text;
        this.shown = text;
    }

    /** Whether `field` can reuse this row's controls. */
    fits(field) {
        return field.type === this.field.type && (field.type !== 'net' || !field.disabled === !this.field.disabled);
    }

    /**
     * @param {PropertyField} field
     * @param {boolean} [initial]
     */
    update(field, initial = false) {
        const previous = this.field;
        this.field = field;
        const control = this.control;
        // A focused control with unsaved edits keeps what the user is typing or stepping.
        const editing = !initial && this.dirty && isFocused(control);
        this.row.dataset.prop = field.prop || field.key;
        if (field.type === 'checkbox') this.text.textContent = field.label;
        else {
            this.label.textContent = field.label;
            setAttr(this.label, 'for', field.type === 'readout' ? '' : field.id);
        }
        if (field.id) control.id = field.id;
        setAttr(control, 'title', field.error || field.title);
        if (field.type === 'readout') {
            control.textContent = field.mixed ? MIXED_LABEL : String(field.value ?? '');
            return;
        }
        control.setCustomValidity?.(field.error || '');
        if (field.error && !initial) control.reportValidity?.();
        control.disabled = !!field.disabled;
        if (field.type === 'checkbox') {
            control.checked = !field.mixed && !!field.value;
            control.indeterminate = !!field.mixed;
            return;
        }
        if (field.type === 'select') {
            this.renderOptions(field);
            return;
        }
        if (field.type === 'number') {
            setAttr(control, 'min', field.min);
            setAttr(control, 'max', field.max);
            setAttr(control, 'step', field.step);
            if (field.numberFormat) control.dataset.numberFormat = field.numberFormat;
            control.placeholder = field.mixed ? MIXED_LABEL : '';
            // Text that already reads as the described number stays as entered.
            const text = String(control.value ?? '').trim();
            const exact = !initial && !field.mixed && text !== '' && text !== this.shown && Number(text) === field.value;
            if (!editing && !exact) this.restore();
            else if (!editing) {
                this.dirty = false;
                if (exact) this.shown = text;
            }
            return;
        }
        const empty = field.placeholder || (field.type === 'net' ? 'None' : '');
        control.placeholder = field.mixed ? MIXED_LABEL : empty;
        if (!editing) control.value = field.mixed ? '' : String(field.value ?? '');
        if (field.type === 'net' && (initial || String(previous.nets) !== String(field.nets)
            || previous.placeholder !== field.placeholder)) this.renderNetMenu(field, empty);
    }

    renderOptions(field) {
        const select = this.control;
        while (select.firstChild) select.removeChild(select.firstChild);
        if (field.mixed) {
            const mixed = element('option');
            mixed.value = '';
            mixed.textContent = MIXED_LABEL;
            mixed.disabled = true;
            select.appendChild(mixed);
        }
        for (const option of field.options || []) {
            const node = element('option');
            node.value = option.value;
            node.textContent = option.label;
            if (option.disabled) node.disabled = true;
            if (option.title) node.title = option.title;
            Object.assign(node.dataset, option.dataset || {});
            select.appendChild(node);
        }
        // Setting the value selects the matching option (the disabled Mixed one when mixed).
        select.value = field.mixed ? '' : String(field.value ?? '');
    }

    /** The menu of existing nets; a disabled net field has none. */
    renderNetMenu(field, empty) {
        this.menu?.remove();
        this.menu = null;
        if (field.disabled) return;
        const menu = this.menu = element('details', 'prop-net-menu');
        const summary = element('summary');
        summary.setAttribute('aria-label', 'Select existing net');
        const list = element('div');
        const buttons = ['', ...(field.nets || []).filter(Boolean)].map(net => {
            const button = element('button');
            button.type = 'button';
            button.dataset.net = net;
            button.textContent = net || empty;
            button.addEventListener('click', () => {
                this.control.value = net;
                menu.open = false;
                this.field.commit?.(net);
            });
            list.appendChild(button);
            return button;
        });
        menu.addEventListener('toggle', () => {
            if (!menu.open) return;
            const current = this.control.value.trim();
            for (const button of buttons) {
                if (button.dataset.net === current) button.setAttribute('aria-current', 'true');
                else button.removeAttribute('aria-current');
            }
        });
        menu.append(summary, list);
        this.netControl.appendChild(menu);
    }
}

/** @type {WeakMap<HTMLElement, Map<string, Row>>} */
const rendered = new WeakMap();

/**
 * Show `fields` in `container`, reusing rows with the same key and type so focused
 * controls survive; rows no longer described are removed. Returns each key's control
 * (for hosts and tests; panel logic should not need it).
 * @param {HTMLElement} container
 * @param {PropertyField[]} fields
 * @param {{placeholder?: string}} [options]
 * @returns {Map<string, any>}
 */
export function renderPropertyFields(container, fields, { placeholder = '' } = {}) {
    const previous = rendered.get(container) || new Map();
    const rows = new Map();
    // Every panel shows its rows in the one canonical order (shared/ui/property-order.js).
    for (const field of sortByPropertyOrder(fields, item => item.prop || item.key)) {
        if (rows.has(field.key)) throw new Error(`Duplicate property field: ${field.key}`);
        const reused = previous.get(field.key);
        if (reused?.fits(field) && reused.row.parentNode === container) {
            reused.update(field);
            rows.set(field.key, reused);
        } else rows.set(field.key, new Row(field));
    }
    const keep = new Set([...rows.values()].map(row => row.row));
    for (const child of [...container.children]) if (!keep.has(child)) container.removeChild(child);
    // Insert new rows in place without moving kept ones (moving a focused control blurs it).
    let next = container.firstChild;
    for (const row of rows.values()) {
        if (row.row === next) next = next.nextSibling;
        else container.insertBefore(row.row, next);
    }
    if (!rows.size && placeholder) {
        const note = element('span', 'props-placeholder');
        note.textContent = placeholder;
        container.appendChild(note);
    }
    rendered.set(container, rows);
    return new Map([...rows].map(([key, row]) => [key, row.control]));
}

/** @type {WeakMap<HTMLElement, HTMLElement[]>} */
const renderedActions = new WeakMap();

/**
 * Show action groups (titled button groups, e.g. Transform) in `container`, replacing
 * the groups shown there before; the container's other children are left alone.
 * @param {HTMLElement} container
 * @param {PropertyActionGroup[]} groups
 */
export function renderPropertyActions(container, groups = []) {
    for (const old of renderedActions.get(container) || []) old.parentNode?.removeChild(old);
    const shown = groups.map(group => {
        const section = element('div', 'ribbon-group prop-action-group');
        section.dataset.group = group.title;
        const title = element('div', 'ribbon-group-title');
        title.textContent = group.title;
        const items = element('div', 'ribbon-group-items prop-actions');
        for (const action of group.actions) {
            const button = element('button', 'prop-action');
            button.type = 'button';
            button.id = action.id;
            button.textContent = action.label;
            if (action.title) button.title = action.title;
            button.disabled = !!action.disabled;
            button.addEventListener('click', () => action.run());
            items.appendChild(button);
        }
        section.append(title, items);
        container.appendChild(section);
        return section;
    });
    renderedActions.set(container, shown);
}

/** A field description by key, for panels' tests and hosts. */
export function propertyField(panel, key) {
    return panel.fields.find(field => field.key === key) || null;
}
