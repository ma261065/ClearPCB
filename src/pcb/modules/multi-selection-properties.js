/**
 * Properties panel for a PCB multi-selection: the editable properties every selected
 * object shares (net, layer, size, rotation, ...), in the canonical property order,
 * each applied to the whole selection as one undo step.
 */
import { TEXT_LAYERS } from '../../core/pcb-text.js';
import { CopperFill } from '../../shapes/copper-fill.js';
import { Track } from '../../shapes/track.js';
import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../../shared/pcb/footprint.js';
import { PICTURE_LAYERS } from '../../shared/pcb/picture-raster.js';
import { measureText as measureStrokeText } from '../../shared/pcb/stroke-font.js';
import { sortByPropertyOrder } from '../../shared/ui/property-order.js';
import { renderPropertyFields } from '../../shared/ui/property-fields.js';
import { applyShapeSnapshot, captureBoardShapeState } from './board-shapes.js';
import { refreshBoxSelectionHighlights } from './box-select.js';
import { ModifyFillCommand } from './copper-fill-commands.js';
import { canEditFill } from './copper-fill-edit.js';
import { PCB_LAYERS, isLayerLocked, pcbLayerOption, showLockedLayerBubble } from './layers.js';
import { isPcbObjectLocked, objectLockCommand } from './object-locks.js';
import { ModifyPadCommand } from './pad-commands.js';
import { isRefTextLocked } from './ref-text-selection.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { EditTextCommand } from './text-commands.js';
import { CompoundCommand, ModifyTrackGraphCommand, ModifyViaCommand, RotatePlacementCommand, SetPlacementLockedCommand, SetPlacementRefVisibleCommand, SetPlacementSideCommand } from './track-commands.js';
import { SetRefStyleCommand } from './ref-text-selection.js';
import { applyNetToCopperSelection } from './track-select.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {'component'|'reftext'|'track'|'via'|'pad'|'shape'|'fill'|'text'} MultiKind */
/** @typedef {import('./selection-registry.js').PcbSelectionEntry} MultiEntry */
/** @typedef {{type: 'number'|'select'|'checkbox'|'net', label: string, get: () => any, command: ((value: any) => any)|null, options?: Array<[any, string]>, disabled?: boolean, min?: number, max?: number, step?: number}} MultiCapability */

/** @param {PcbEditor} app @param {MultiEntry} entry @returns {Record<string, MultiCapability>} */
export function multiPropertyCapabilities(app, entry) {
    const { kind, object } = entry;
    /** @param {string} label @param {() => any} get @param {((value: any) => any)|null} command @param {number} [min] @param {number} [step] @param {number} [max] @returns {MultiCapability} */
    const number = (label, get, command, min = -Infinity, step = 1, max = Infinity) => (
        { type: 'number', label, get, command, min, max, step }
    );
    /** @param {string} label @param {() => any} get @param {((value: any) => any)|null} command @param {Array<[any, string]>} options @param {boolean} [disabled] @returns {MultiCapability} */
    const select = (label, get, command, options, disabled = false) => (
        { type: 'select', label, get, command, options, disabled }
    );
    /** @param {string} label @param {() => any} get @param {((value: any) => any)|null} command @param {boolean} [disabled] @returns {MultiCapability} */
    const checkbox = (label, get, command, disabled = false) => (
        { type: 'checkbox', label, get, command, disabled }
    );
    /** @param {() => any} get @param {((value: any) => any)|null} command @returns {MultiCapability} */
    const net = (get, command) => ({ type: 'net', label: 'Net', get, command });
    /** @param {(target: any) => void} mutate */
    const shapeCommand = (mutate) => {
        const before = captureBoardShapeState(object);
        const candidate = { ...object };
        applyShapeSnapshot(candidate, before);
        mutate(candidate);
        const after = captureBoardShapeState(candidate);
        return JSON.stringify(before) === JSON.stringify(after)
            ? null : new ModifyBoardShapeCommand(app, object, before, after);
    };
    /** @param {(target: CopperFill) => void} mutate */
    const fillCommand = (mutate) => {
        const before = object.captureState();
        const candidate = new CopperFill(before);
        mutate(candidate);
        const after = candidate.captureState();
        return JSON.stringify(before) === JSON.stringify(after)
            ? null : new ModifyFillCommand(app, object, before, after);
    };
    /** @param {CopperFill} fill */
    const fillBounds = fill => /** @type {{minX: number, minY: number, maxX: number, maxY: number}} */ (fill.getBounds());
    /** @param {string} property @param {any} value */
    const padCommand = (property, value) => {
        const before = object.captureState();
        const after = { ...before, [property]: value };
        if (property === 'size') after.drill = Math.min(after.drill, value);
        return JSON.stringify(before) === JSON.stringify(after)
            ? null : new ModifyPadCommand(app, object, before, after);
    };
    /** @type {Record<string, MultiCapability>} */
    const capabilities = {};
    if (kind === 'component') {
        const placement = app.placements.get(object);
        if (!placement) return capabilities;
        const locked = !!placement.locked;
        capabilities.locked = checkbox('Locked', () => !!placement.locked,
            value => new SetPlacementLockedCommand(app, object, value));
        capabilities.refVisible = checkbox('Show Reference', () => placement.refVisible !== false,
            value => new SetPlacementRefVisibleCommand(app, object, value), locked);
        capabilities.layer = select('Layer', () => placement.side === 'bottom' ? 'bottom' : 'top',
            value => new SetPlacementSideCommand(app, object, value),
            [['top', 'Top'], ['bottom', 'Bottom']], locked);
        capabilities.rotation = number('Rotation (°)', () => ((placement.rotation || 0) % 360 + 360) % 360,
            value => new RotatePlacementCommand(app, object, placement.rotation || 0, value),
            -Infinity, 1, Infinity);
        capabilities.rotation.disabled = locked;
    } else if (kind === 'text') {
        capabilities.layer = select('Layer', () => object.layer,
            value => {
                /** @type {Record<string, any>} */
                const after = { layer: value };
                const wasBottom = String(object.layer).startsWith('bottom-');
                const willBottom = String(value).startsWith('bottom-');
                if (wasBottom !== willBottom) {
                    const width = measureStrokeText(object.content, object.size);
                    const sign = willBottom ? 1 : -1;
                    const radians = (object.rotation || 0) * Math.PI / 180;
                    after.x = object.x + sign * width * Math.cos(radians);
                    after.y = object.y - sign * width * Math.sin(radians);
                }
                return new EditTextCommand(app, object.id, after);
            },
            TEXT_LAYERS.map(layer => [layer, app.layerLabel(layer)]));
        capabilities.size = number('Text Size (mm)', () => object.size,
            value => new EditTextCommand(app, object.id, { size: value }), 0.1, 0.1);
        capabilities.rotation = number('Rotation (°)', () => object.rotation || 0,
            value => new EditTextCommand(app, object.id, { rotation: value }), -Infinity, 1);
        capabilities.lineWidth = number('Line Width (mm)', () => object.strokeWidth,
            value => new EditTextCommand(app, object.id, { strokeWidth: value }), 0.01, 0.05);
        capabilities.border = checkbox('Border', () => !!object.border,
            value => new EditTextCommand(app, object.id, { border: value }));
        for (const capability of Object.values(capabilities)) capability.disabled = isLayerLocked(object.layer);
    } else if (kind === 'reftext') {
        const placement = app.placements.get(object);
        if (!placement) return capabilities;
        const locked = isRefTextLocked(placement);
        const currentSize = () => placement.refSize || REF_DEFAULT_SIZE;
        const currentWidth = () => placement.refStrokeWidth || REF_DEFAULT_STROKE;
        const currentRotation = () => placement.refRot || 0;
        capabilities.size = number('Text Size (mm)', currentSize,
            value => new SetRefStyleCommand(app, object,
                { refSize: currentSize(), refStrokeWidth: currentWidth(), refRot: currentRotation() },
                { refSize: value, refStrokeWidth: currentWidth(), refRot: currentRotation() }),
            0.1, 0.1);
        capabilities.rotation = number('Rotation (°)', currentRotation,
            value => new SetRefStyleCommand(app, object,
                { refSize: currentSize(), refStrokeWidth: currentWidth(), refRot: currentRotation() },
                { refSize: currentSize(), refStrokeWidth: currentWidth(), refRot: value }),
            -Infinity, 1);
        capabilities.lineWidth = number('Line Width (mm)', currentWidth,
            value => new SetRefStyleCommand(app, object,
                { refSize: currentSize(), refStrokeWidth: currentWidth(), refRot: currentRotation() },
                { refSize: currentSize(), refStrokeWidth: value, refRot: currentRotation() }),
            0.01, 0.05);
        for (const capability of Object.values(capabilities)) capability.disabled = locked;
    } else if (kind === 'fill') {
        capabilities.net = net(() => String(object.net || ''),
            value => fillCommand(target => { target.net = value; }));
        capabilities.layer = select('Layer', () => object.layer,
            value => fillCommand(target => { target.layer = value; }),
            [['top-copper', 'Top Copper'], ['bottom-copper', 'Bottom Copper']]);
        capabilities.shapeKind = select('Outline', () => object.kind,
            value => fillCommand(target => {
                if (value === target.kind) return;
                const bounds = fillBounds(target);
                const contour = target.getOutline();
                target.kind = value;
                target.cornerRadius = 0;
                target.nodeCornerRadii = {};
                target.segmentBulges = {};
                if (value === 'circle') {
                    target.outline = [];
                    target.x = (bounds.minX + bounds.maxX) / 2;
                    target.y = (bounds.minY + bounds.maxY) / 2;
                    target.radius = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
                } else {
                    target.outline = value === 'polygon' ? contour : [
                        { x: bounds.minX, y: bounds.minY },
                        { x: bounds.maxX, y: bounds.minY },
                        { x: bounds.maxX, y: bounds.maxY },
                        { x: bounds.minX, y: bounds.maxY },
                    ];
                }
            }), [['rect', 'Rectangle'], ['polygon', 'Polygon'], ['circle', 'Circle']]);
        if (object.kind === 'circle') {
            capabilities.diameter = number('Diameter (mm)', () => object.radius * 2,
                value => fillCommand(target => { target.radius = value / 2; }), 0.1, 0.05);
        } else {
            capabilities.cornerRadius = number('Corner Radius (mm)', () => object.cornerRadius || 0,
                value => fillCommand(target => {
                    target.cornerRadius = value;
                    target.nodeCornerRadii = {};
                }), 0, 0.05);
            if (object.kind === 'rect') {
                /** @param {'x'|'y'} axis @param {number} value */
                const resizeFill = (axis, value) => fillCommand(target => {
                    const bounds = fillBounds(target);
                    const min = axis === 'x' ? 'minX' : 'minY';
                    const max = axis === 'x' ? 'maxX' : 'maxY';
                    if (value === bounds[max] - bounds[min]) return;
                    const factor = value / (bounds[max] - bounds[min]);
                    target.outline = target.outline.map(/** @param {{x: number, y: number}} point */ point => ({
                        ...point,
                        [axis]: bounds[min] + (point[axis] - bounds[min]) * factor,
                    }));
                });
                capabilities.width = number('Width (mm)', () => {
                    const bounds = fillBounds(object);
                    return bounds.maxX - bounds.minX;
                }, value => resizeFill('x', value), 0.1, 0.05);
                capabilities.height = number('Height (mm)', () => {
                    const bounds = fillBounds(object);
                    return bounds.maxY - bounds.minY;
                }, value => resizeFill('y', value), 0.1, 0.05);
            }
        }
        for (const capability of Object.values(capabilities)) {
            capability.disabled = !canEditFill(object);
        }
    } else if (kind === 'pad') {
        capabilities.net = net(() => String(object.net || ''), value => padCommand('net', value));
        capabilities.size = number('Size (mm)', () => object.size,
            value => padCommand('size', value), 0.05, 0.05);
        capabilities.rotation = number('Rotation (°)', () => object.rotation || 0,
            value => padCommand('rotation', value), -Infinity, 1);
    } else if (kind === 'via') {
        capabilities.net = net(() => String(object.net || ''),
            value => new ModifyViaCommand(app, object, { net: object.net || '' }, { net: value }));
        capabilities.diameter = number('Diameter (mm)', () => object.diameter,
            value => new ModifyViaCommand(app, object, { diameter: object.diameter }, { diameter: value }),
            object.drill, 0.05);
        capabilities.drill = number('Drill (mm)', () => object.drill,
            value => new ModifyViaCommand(app, object, { drill: object.drill }, { drill: value }),
            0.05, 0.05, object.diameter);
    } else if (kind === 'track') {
        capabilities.net = net(() => String(object.net || ''), null);
        capabilities.lineWidth = number('Width (mm)', () => object.width,
            value => {
                const before = object.captureState();
                const candidate = new Track({ id: object.id });
                candidate.applyState(before);
                candidate.width = value;
                for (const edgeId of candidate.edges.keys()) candidate.setEdgeAttr(edgeId, 'width', value);
                const after = candidate.captureState();
                return JSON.stringify(before) === JSON.stringify(after)
                    ? null : new ModifyTrackGraphCommand(app, object, before, after);
            }, 0.05, 0.05);
    } else if (kind === 'shape') {
        const copper = object.layer === 'top-copper' || object.layer === 'bottom-copper';
        if (copper && normalizeShapeCopperMode(object.copperMode) === 'add') {
            capabilities.net = net(() => String(object.net || ''),
                value => shapeCommand(target => { target.net = value; }));
        }
        capabilities.layer = select('Layer', () => object.layer,
            value => shapeCommand(target => { target.layer = value; }),
            PCB_LAYERS.filter(layer => layer.id !== 'vias' && (object.kind !== 'image'
                ? layer.id !== 'board-outline' : PICTURE_LAYERS.includes(layer.id)))
                .map(layer => [layer.id, layer.name]));
        if (object.kind === 'image') {
            const imageSize = (target = object) => ({
                width: Math.hypot(target.points[1].x - target.points[0].x, target.points[1].y - target.points[0].y),
                height: Math.hypot(target.points[3].x - target.points[0].x, target.points[3].y - target.points[0].y),
            });
            /** @param {'width'|'height'} dimension @param {number} value */
            const resize = (dimension, value) => shapeCommand(target => {
                const current = imageSize(target);
                const base = current[dimension];
                if (value === base) return;
                const factor = value / base;
                const center = { x: (target.points[0].x + target.points[2].x) / 2,
                    y: (target.points[0].y + target.points[2].y) / 2 };
                target.points = target.points.map(/** @param {{x: number, y: number}} point */ point => ({
                    x: center.x + (point.x - center.x) * factor,
                    y: center.y + (point.y - center.y) * factor,
                }));
            });
            capabilities.width = number('Width (mm)', () => imageSize().width,
                value => resize('width', value), 0.1, 0.1, 500);
            capabilities.height = number('Height (mm)', () => imageSize().height,
                value => resize('height', value), 0.1, 0.1, 500);
            capabilities.rotation = number('Rotation (°)', () => (
                (-Math.atan2(object.points[1].y - object.points[0].y,
                    object.points[1].x - object.points[0].x) * 180 / Math.PI) % 360 + 360
            ) % 360, value => shapeCommand(target => {
                const current = (-Math.atan2(target.points[1].y - target.points[0].y,
                    target.points[1].x - target.points[0].x) * 180 / Math.PI + 360) % 360;
                if (value === current) return;
                const radians = -(value - current) * Math.PI / 180;
                const cosine = Math.cos(radians), sine = Math.sin(radians);
                const center = { x: (target.points[0].x + target.points[2].x) / 2,
                    y: (target.points[0].y + target.points[2].y) / 2 };
                target.points = target.points.map(/** @param {{x: number, y: number}} point */ point => ({
                    x: center.x + (point.x - center.x) * cosine - (point.y - center.y) * sine,
                    y: center.y + (point.x - center.x) * sine + (point.y - center.y) * cosine,
                }));
            }), -Infinity, 1);
            capabilities.invert = checkbox('Invert', () => !!object.artwork?.invert,
                value => shapeCommand(target => { target.artwork = { ...target.artwork, invert: value }; }));
            capabilities.flipHorizontal = checkbox('Flip Horizontal', () => !!object.artwork?.flipHorizontal,
                value => shapeCommand(target => { target.artwork = { ...target.artwork, flipHorizontal: value }; }));
            capabilities.flipVertical = checkbox('Flip Vertical', () => !!object.artwork?.flipVertical,
                value => shapeCommand(target => { target.artwork = { ...target.artwork, flipVertical: value }; }));
        } else {
            capabilities.lineWidth = number('Line Width (mm)', () => object.lineWidth || 0.2,
                value => shapeCommand(target => { target.lineWidth = value; }), 0.05, 0.05);
        }
    }
    // Components carry their placement lock above; reference text follows it, and the
    // board outline is locked through its layer.
    if (kind !== 'component' && kind !== 'reftext' && !(kind === 'shape' && object.layer === 'board-outline')) {
        const locked = isPcbObjectLocked(app, kind, object);
        for (const capability of Object.values(capabilities)) capability.disabled ||= locked;
        capabilities.locked = checkbox('Locked', () => !!object.locked,
            value => !!object.locked === value ? null : objectLockCommand(app, kind, object, value));
    }
    return capabilities;
}

/**
 * Show the editable intersection of properties for any PCB multi-selection.
 * @param {PcbEditor} app
 * @param {MultiEntry[]} entries
 */
export function showMultiSelectionProperties(app, entries) {
    const items = app.propertiesItems();
    if (!items) return;
    const hasShapes = entries.some(entry => entry.kind === 'shape');
    app.setPropertiesTitle(`${entries.length} Selected`);
    const capabilitySets = entries.map(entry => multiPropertyCapabilities(app, entry));
    let keys = Object.keys(capabilitySets[0] || {});
    for (const capabilities of capabilitySets.slice(1)) {
        keys = keys.filter(key => capabilities[key]?.type === capabilitySets[0][key]?.type);
    }
    // Locked shows whenever any member has its own lock (the board outline has none), so a
    // Select All can always be unlocked in one step; it applies to the members that have one.
    if (!keys.includes('locked') && capabilitySets.some(capabilities => capabilities.locked)) keys.push('locked');
    keys = sortByPropertyOrder(keys, key => key);
    /** @type {Map<string, {group: MultiCapability[], descriptor: MultiCapability}>} */
    const descriptors = new Map();
    /** @type {PropertyField[]} */
    const fields = [];
    /** @param {string} key @param {any} value */
    const commit = (key, value) => {
        const info = descriptors.get(key);
        if (!info || info.group.every(capability => capability.disabled)) return;
        const editable = info.group.map(capability => !capability.disabled);
        if (key === 'layer' && hasShapes && isLayerLocked(value)) {
            showLockedLayerBubble(app, value);
            showMultiSelectionProperties(app, entries);
            return;
        }
        if (key === 'net') {
            const targets = /** @type {Parameters<typeof applyNetToCopperSelection>[1]} */ (entries.filter((entry, index) => editable[index]));
            /** @param {MultiEntry} entry */
            const routed = entry => entry.kind === 'track' || entry.kind === 'via';
            const otherCommands = entries.map((entry, index) => !editable[index] || routed(entry)
                ? null : info.group[index].command?.(value)).filter(Boolean);
            if (!applyNetToCopperSelection(app, targets, value, otherCommands)) {
                showMultiSelectionProperties(app, entries);
                return;
            }
        } else {
            const commands = info.group.filter(capability => !capability.disabled)
                .map(capability => capability.command?.(value)).filter(Boolean);
            if (commands.length) {
                app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            }
        }
        refreshBoxSelectionHighlights(app);
        showMultiSelectionProperties(app, entries);
    };
    for (const key of keys) {
        const group = capabilitySets.map(capabilities => capabilities[key]).filter(Boolean);
        const descriptor = group[0];
        if (descriptor.type === 'select') {
            const descriptorOptions = /** @type {Array<[any, string]>} */ (descriptor.options);
            const allowed = new Set(descriptorOptions.map(([value]) => value));
            for (const candidate of group.slice(1)) {
                const candidateOptions = /** @type {Array<[any, string]>} */ (candidate.options);
                const values = new Set(candidateOptions.map(([value]) => value));
                for (const value of [...allowed]) if (!values.has(value)) allowed.delete(value);
            }
            descriptor.options = descriptorOptions.filter(([value]) => allowed.has(value));
            if (!descriptor.options.length) continue;
        }
        const values = group.map(candidate => candidate.get());
        const mixed = values.some(value => value !== values[0]);
        const allTracks = entries.every(entry => entry.kind === 'track');
        const id = key === 'net' ? 'pcbPropMultiNet'
            : key === 'lineWidth' && allTracks ? 'pcbPropMultiTrackWidth'
                : `pcbPropIntersection_${key}`;
        descriptors.set(key, { group, descriptor });
        // Locked members keep their values; the row stays editable while any member can take an edit.
        /** @type {PropertyField & Record<string, any>} */
        const field = { key, id, type: descriptor.type, label: descriptor.label, value: values[0], mixed,
            disabled: group.every(item => item.disabled), commit: value => commit(key, value) };
        if (descriptor.type === 'select') {
            const descriptorOptions = /** @type {Array<[any, string]>} */ (descriptor.options);
            field.options = descriptorOptions.map(([value, label]) => key === 'layer' && hasShapes
                ? pcbLayerOption(value, label) : { value, label });
        } else if (descriptor.type === 'net') {
            field.nets = app.netNames();
        } else if (descriptor.type === 'number') {
            const min = Math.max(...group.map(item => /** @type {number} */ (item.min)));
            const max = Math.min(...group.map(item => /** @type {number} */ (item.max)));
            Object.assign(field, { min, max, step: descriptor.step, commit: /** @param {number} value */ value => {
                if (key === 'rotation') value = ((value % 360) + 360) % 360;
                commit(key, Math.max(min, Math.min(max, value)));
            } });
        }
        fields.push(field);
    }
    renderPropertyFields(items, fields, { placeholder: 'No shared editable properties' });
    app.showPropertiesTab?.();
    app.syncClipboardButtons?.();
}
