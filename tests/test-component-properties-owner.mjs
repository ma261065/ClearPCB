import assert from 'node:assert/strict';
import { ComponentProperties } from '../src/pcb/modules/component-properties.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { attachPropertyPanelHarness } from './helpers/property-panel-controls.mjs';

class Element {
    constructor() {
        this.children = [];
        this.controls = new Map();
        this.listeners = new Map();
        this.value = '';
    }
    set innerHTML(html) {
        this.html = html;
        this.children = [];
        this.controls.clear();
        for (const match of html.matchAll(/<(input|button|select)[^>]*id="([^"]+)"([^>]*)>/g)) {
            const input = new Element();
            input.tag = match[1];
            input.value = match[3].match(/value="([^"]*)"/)?.[1] || '';
            input.disabled = match[3].includes('disabled');
            input.checked = match[3].includes('checked');
            this.controls.set(match[2], input);
            this.appendChild(input);
        }
    }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { this.children.push(child); child.parent = this; }
    remove() {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }
    querySelector(selector) { return this.controls.get(selector.slice(1)) || null; }
    querySelectorAll(selector) { return this.children.filter(child => child.tag === selector); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    fire(type) { for (const listener of this.listeners.get(type) || []) listener({ type }); }
}

function fixture() {
    let active = true, available = true, selected = true;
    let placement = { reference: 'R1', side: 'bottom', mirror: true, rotation: 37.123456789,
        x: Math.PI, y: -Math.E, refSize: 1.23456789, refStrokeWidth: 0.123456789,
        refRot: 23.456789, model3dObj: 'model' };
    const controls = new Map(), buttons = new Map();
    const propertyHost = {};
    attachPropertyPanelHarness(propertyHost, { controls, actions: buttons });
    const items = { querySelector: selector => controls.get(selector.slice(1)) || null };
    const actions = [], renders = [], overlays = [], bindings = [], titles = [];
    let owner;
    const capabilities = Object.freeze({
        getPlacement: id => id === 'part' ? placement : undefined,
        isActive: () => active,
        isSelected: (kind, id) => selected && id === 'part',
        openPanel: panel => available ? propertyHost.openPropertyPanel(panel) : false,
        refreshPanel: panel => propertyHost.refreshPropertyPanel(panel),
        layerLabel: layer => layer,
        rotate: (id, before, after) => {
            actions.push(['rotate', id, before, after]);
            placement.rotation = after;
            owner.syncRotationInput(id);
        },
        setLocked: (id, locked) => { actions.push(['lock', id, locked]); placement.locked = locked; },
        setReferenceVisible: (id, visible) => actions.push(['reference', id, visible]),
        setSide: (id, side) => actions.push(['side', id, side]),
        flip: (id, axis) => actions.push(['flip', id, axis]),
        open3D: id => actions.push(['3d', id]),
        renderReference: id => renders.push(id),
        drawReferenceOverlay: (id, tether) => overlays.push([id, tether]),
        setReferenceStyle: (id, before, after) => {
            assert.deepEqual(
                Object.fromEntries(Object.keys(before).map(key => [key, placement[key]])), before,
                'Command receives the exact pre-preview baseline without any rollback repaint');
            actions.push(['style', id, before, after]);
            Object.assign(placement, after);
        },
        // The owner's contract uses a binding service, not a PCBApp-shaped object.
        // Real helper parsing/history/keyboard contracts remain integration-tested.
        bindStrokeText: (model, spec) => {
            let snapshot = null, disposed = false;
            const binding = {
                model, spec, disposals: 0,
                get active() { return snapshot !== null; },
                fields(disabled = false) {
                    return spec.fields.map(field => ({
                        key: field.key || field.field,
                        id: field.id,
                        type: field.type || 'number',
                        label: field.label,
                        value: field.value ? field.value(model) : model[field.field],
                        disabled,
                    }));
                },
                input(field, value) {
                    if (disposed) return;
                    if (!spec.editable()) { binding.cancel(); return; }
                    const parsed = spec.fields.find(candidate => candidate.field === field).parse(value);
                    if (parsed == null) return;
                    snapshot ??= { ...model };
                    model[field] = parsed;
                    spec.preview(model);
                },
                commit() {
                    if (disposed || !snapshot) return;
                    if (!spec.editable()) { binding.cancel(); return; }
                    const before = snapshot;
                    snapshot = null;
                    spec.commit(model, before);
                },
                cancel() {
                    if (!snapshot) return;
                    const before = snapshot;
                    snapshot = null;
                    spec.cancel(before);
                },
                dispose() {
                    if (disposed) return;
                    binding.cancel();
                    disposed = true;
                    binding.disposals++;
                },
            };
            bindings.push(binding);
            return binding;
        },
    });
    owner = new ComponentProperties(capabilities);
    return { owner, items, buttons, actions, renders, overlays, bindings, titles,
        get placement() { return placement; },
        replace() { placement = { ...placement }; },
        setActive(value) { active = value; },
        setAvailable(value) { available = value; },
        setSelected(value) { selected = value; },
    };
}

{
    const f = fixture();
    f.setAvailable(false);
    f.owner.showComponent('part');
    f.owner.showReference('part');
    assert.equal(f.owner.panel, null);
    assert.deepEqual(f.titles, []);
    assert.equal(f.owner.active, false);
}

{
    const f = fixture();
    f.owner.showComponent('part');
    const rotation = f.items.querySelector('#pcbPropCompRot');
    rotation.value = '401.6';
    rotation.fire('change');
    assert.deepEqual(f.actions.pop(), ['rotate', 'part', 37.123456789, 42]);
    assert.equal(rotation.value, '42');
    assert.equal(f.items.querySelector('#pcbPropCompRot'), rotation, 'Synchronization retains the focused input');
    rotation.value = '';
    rotation.fire('change');
    assert.equal(rotation.value, '42');
    assert.deepEqual(f.actions, [], 'Invalid rotation restores the field without a command');
    f.buttons.get('pcbPropRotateLeft').fire('click');
    assert.deepEqual(f.actions.pop(), ['rotate', 'part', 42, 312]);
    f.buttons.get('pcbPropRotateRight').fire('click');
    assert.deepEqual(f.actions.pop(), ['rotate', 'part', 312, 42]);
    const side = f.items.querySelector('#pcbPropCompSide');
    side.value = 'invalid';
    side.fire('change');
    assert.deepEqual(f.actions.pop(), ['side', 'part', 'top']);
    side.value = 'bottom';
    side.fire('change');
    assert.deepEqual(f.actions.pop(), ['side', 'part', 'bottom']);
    f.buttons.get('pcbPropShow3D').fire('click');
    assert.deepEqual(f.actions.pop(), ['3d', 'part']);
    const reference = f.items.querySelector('#pcbPropCompRefVis');
    reference.checked = false;
    reference.fire('change');
    assert.deepEqual(f.actions.pop(), ['reference', 'part', false]);
    const locked = f.items.querySelector('#pcbPropCompLocked');
    locked.checked = true;
    locked.fire('change');
    assert.deepEqual(f.actions.pop(), ['lock', 'part', true]);
    locked.fire('change');
    f.buttons.get('pcbPropRotateLeft').fire('click');
    side.fire('change');
    reference.fire('change');
    assert.deepEqual(f.actions, [], 'Locked components reject transforms and duplicate lock commands');
    locked.checked = false;
    locked.fire('change');
    assert.deepEqual(f.actions.pop(), ['lock', 'part', false]);
    const staleFlipH = f.buttons.get('pcbPropFlipH');
    f.buttons.get('pcbPropFlipV').fire('click');
    assert.deepEqual(f.actions.pop(), ['flip', 'part', 'V']);
    staleFlipH.fire('click');
    assert.deepEqual(f.actions, [], 'Detached Transform callbacks cannot rebuild the panel');
}

for (const boundary of ['inactive', 'replace', 'dispose', 'reference']) {
    const f = fixture();
    f.owner.showComponent('part');
    const controls = [
        f.items.querySelector('#pcbPropCompRot'),
        f.items.querySelector('#pcbPropCompSide'),
        f.items.querySelector('#pcbPropCompRefVis'),
        f.items.querySelector('#pcbPropCompLocked'),
        ...f.buttons.values(),
    ];
    if (boundary === 'inactive') f.setActive(false);
    if (boundary === 'replace') f.replace();
    if (boundary === 'dispose') f.owner.dispose();
    if (boundary === 'reference') f.owner.showReference('part');
    for (const input of controls) {
        input.value = '150';
        input.checked = true;
        input.fire('change');
        input.fire('click');
    }
    assert.deepEqual(f.actions, [], `${boundary}: reject every stale component callback`);
}

{
    const f = fixture();
    f.owner.showReference('part');
    const binding = f.bindings[0];
    assert.equal(binding.model, f.placement);
    assert.equal(f.owner.affectsLayer('bottom-silk'), true);
    assert.equal(f.owner.affectsLayer('top-silk'), false);
    assert.equal(f.items.querySelector('#pcbPropRefName').textContent, 'R1');
    assert.equal(f.items.querySelector('#pcbPropRefLayer').textContent, 'bottom-silk');
    assert.equal(binding.spec.fields[1].parse('-1'), 359);
    for (const field of binding.spec.fields) assert.equal(field.parse(''), null);
    binding.input('refSize', '2.3456789');
    assert.equal(f.owner.active, true);
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.overlays.pop(), ['part', true]);
    const rendersBeforeCommit = f.renders.length;
    f.owner.commit();
    assert.equal(f.owner.active, false);
    assert.equal(f.renders.length, rendersBeforeCommit, 'The owner does not repaint the temporary rollback');
    assert.deepEqual(f.actions.pop(), ['style', 'part',
        { refSize: 1.23456789, refStrokeWidth: 0.123456789, refRot: 23.456789 },
        { refSize: 2.3456789, refStrokeWidth: 0.123456789, refRot: 23.456789 }]);
    delete f.placement.refRot;
    binding.input('refRot', '25');
    Object.assign(f.placement, { x: 99, y: 100, mirror: false, reference: 'R2', refDx: 4.56789 });
    f.owner.cancel();
    assert.equal(Object.hasOwn(f.placement, 'refRot'), false);
    assert.deepEqual([f.placement.x, f.placement.y, f.placement.mirror, f.placement.reference, f.placement.refDx],
        [99, 100, false, 'R2', 4.56789], 'Cancellation restores only style, never pointer/body/reference changes');
    assert.deepEqual(f.overlays.pop(), ['part', false]);
    f.setSelected(false);
    const overlays = f.overlays.length;
    binding.input('refSize', '3');
    f.owner.cancel();
    assert.equal(f.overlays.length, overlays, 'Unselected references do not acquire an overlay');
    f.owner.dispose();
    f.owner.dispose();
    assert.equal(binding.disposals, 1);
    assert.equal(f.owner.referenceBinding, null);
    assert.equal(f.owner.panel, null);
    binding.input('refSize', '99');
    assert.equal(f.placement.refSize, 2.3456789);
}

for (const boundary of ['inactive', 'replace', 'hidden', 'locked', 'layer-locked', 'layer-hidden', 'panel']) {
    const f = fixture();
    const silk = PCB_LAYERS.find(layer => layer.id === 'bottom-silk');
    const beforeLayer = { locked: silk.locked, visible: silk.visible };
    try {
        f.owner.showReference('part');
        const binding = f.bindings[0], original = f.placement;
        binding.input('refSize', '3');
        if (boundary === 'inactive') f.setActive(false);
        if (boundary === 'replace') f.replace();
        if (boundary === 'hidden') f.placement.refVisible = false;
        if (boundary === 'locked') f.placement.locked = true;
        if (boundary === 'layer-locked') silk.locked = true;
        if (boundary === 'layer-hidden') silk.visible = false;
        if (boundary === 'panel') f.owner.showComponent('part');
        f.owner.commit();
        assert.equal(original.refSize, 1.23456789, `${boundary}: restore exact baseline`);
        assert.deepEqual(f.actions, [], `${boundary}: cancelled preview never commands`);
        assert.equal(f.owner.active, false);
        if (boundary === 'inactive') {
            assert.equal(f.owner.referenceBinding, binding, 'Deactivation keeps the reusable binding');
            f.setActive(true);
            binding.input('refSize', '4');
            f.owner.commit();
            assert.equal(f.actions.length, 1, 'Reactivation reuses the retained controls');
        }
    } finally {
        Object.assign(silk, beforeLayer);
    }
}

console.log('PASS narrow component/reference Properties owner: controls, stale callbacks, lifecycle, policies and style-only rollback');
