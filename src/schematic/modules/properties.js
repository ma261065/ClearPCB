import { propertyRank, sortByPropertyOrder } from '../../shared/ui/property-order.js';
import { ModifyPropertyCommand, ModifyShapeCommand, BatchCommand } from './commands.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { bulgeRatio } from '../../core/geometry.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { adaptShortcutText } from './platform-keys.js';
import { appendArcToLineCommand } from './context-menu.js';
import { hasAny3DModel, openComponent3DFromData } from '../../components/model3d-source.js';
import { redrawPropertyPreview, createPropertyPreview, createPropertyBinding } from '../../shapes/property-preview.js';
import { canRoundPathNode } from '../../shapes/path-geometry.js';
import { beginPastePreview, cutSelection } from './clipboard.js';
import { flipComponentH, flipComponentV, rotateComponentLeft, rotateComponentRight } from './components.js';
import { hasOwnLock, isSchematicLocked } from '../../shapes/lock-owner.js';
import { runSchematicDeleteAction } from './editor-actions.js';
import { getShapeNodeFocus, getShapeSegmentFocus, setShapeNodeFocus, setShapeSegmentFocus } from './shape-focus.js';
import { renderSchematicPropertyPanel } from './property-host.js';
import { getSchematicTextEdit } from './text-edit.js';
import { isComponentItem, isNetItem, isPolylineItem, isTextItem, isWireItem, isWireOrNetItem, isCircleItem } from '../../core/schematic-items.js';
import { applySchematicItemState } from '../../core/schematic-state.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../shapes/arc.js').Arc} Arc */
/** @typedef {import('../../shapes/circle.js').Circle} Circle */
/** @typedef {import('../../shapes/net.js').Net} Net */
/** @typedef {import('../../shapes/polyline.js').Polyline} Polyline */
/** @typedef {import('../../shapes/text.js').Text} Text */
/** @typedef {import('../../shapes/wire.js').Wire} Wire */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyAction} PropertyAction */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyActionGroup} PropertyActionGroup */
/** @typedef {import('../../shapes/property-preview.js').PropertyBinding} PropertyBinding */
/** @typedef {import('../../shapes/property-preview.js').PropertyPreview} PropertyPreview */

/** @typedef {{value: string, label: string, disabled?: boolean, title?: string, dataset?: Record<string, string>}} PropertyOption */
/** @typedef {{key: string, label: string, type: string, min?: number, max?: number, step?: number, readonly?: boolean, orderKey?: string, options?: PropertyOption[], [extra: string]: unknown}} PropertyDescriptor */
/** @typedef {{shape: Polyline, edgeId: string}} SelectedSegment */
/** @typedef {{shape: Polyline, nodeId: string}} SelectedNode */
/** @typedef {{selection: SchematicItem[], segmentShape: SchematicItem|null, segmentEdge: string|null, nodeShape: SchematicItem|null, nodeId: string|null}} PropertyContextSnapshot */
/** @typedef {{binding: PropertyBinding, context: PropertyContextSnapshot|null, previews: Map<string, PropertyPreview>, isCurrent: () => boolean, generation: number}} PropertyState */
/** @typedef {{selectedSegment: SelectedSegment|null, selectedNode: SelectedNode|null, singleWire: Wire|null, singlePolyline: Polyline|null, allLocked: boolean, state: PropertyState, isCurrentSelection: () => boolean, applyProperty: (key: string, value: unknown) => void}} DescriptorContext */
/** @typedef {import('../../ui/SchematicApp.js').SchematicToolOptions & {wireNet?: string}} ToolOptions */
/** @typedef {{propertiesPanel?: HTMLElement|null}} PropertiesPanelUi */

/** @type {WeakMap<HTMLElement, {binding: PropertyBinding, previews: Map<string, PropertyPreview>}>} */
const propertyPanels = new WeakMap();
/** @type {WeakMap<SchematicEditor, PropertyState>} */
const propertyStates = new WeakMap();
/** @param {SchematicItem} item @returns {item is Polyline|Circle|Arc} */
const isGeometryStateItem = item => item.type === 'polyline' || item.type === 'circle' || item.type === 'arc';
/** @param {SchematicItem} item @returns {item is Text & {parentComponent: NonNullable<Text['parentComponent']>}} */
const isReferenceTextField = item => isTextItem(item) && !!item.parentComponent && item.fieldKey === 'reference';
/** @param {SchematicItem} item @returns {item is Text & {parentComponent: NonNullable<Text['parentComponent']>}} */
const isWireLabelTextField = item => isTextItem(item) && item.parentComponent?.type === 'wire'
    && (item.fieldKey === 'wireLabel' || item.fieldKey === 'label');

/**
 * Property descriptors come from the selected item, so descriptor keys address
 * that item's public fields even when the concrete union member differs.
 * @param {SchematicItem} item
 * @returns {Record<string, unknown>}
 */
const propertyBag = item => /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (item));
/** @param {SchematicItem} item @param {string} key */
const propertyValue = (item, key) => propertyBag(item)[key];
/** @param {SchematicItem} item @param {string} key @param {unknown} value */
const setPropertyValue = (item, key, value) => { propertyBag(item)[key] = value; };

/** @param {SchematicEditor} app */
export function hasSchematicPropertyPreview(app) {
    return !!propertyStates.get(app)?.binding.active;
}

/** @param {SchematicEditor} app */
export function cancelSchematicPropertyPreview(app) {
    const state = propertyStates.get(app);
    if (!state) return false;
    const active = state.binding.active;
    const cancelled = state.binding.cancel() || false;
    if (active) state.generation = (state.generation || 0) + 1;
    return cancelled;
}

/**
 * Initializes the properties panel and subscribes to `selectionChanged`
 * events to rebuild it when the selection changes.
 * @param {SchematicEditor} app
 */
export function bindPropertiesPanel(app) {
    if (!/** @type {PropertiesPanelUi} */ (app.ui).propertiesPanel) return;

    updatePropertiesPanel(app, []);

    app.eventBus.on('selectionChanged', /** @param {SchematicItem[]} shapes */ (shapes) => {
        updatePropertiesPanel(app, shapes);
    });
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * Compute the intersection of property descriptors across all selected items.
 * Only properties declared by *every* item in the selection are shown.
 * @param {SchematicItem[]} selection
 * @returns {PropertyDescriptor[]}
 */
export function mergeDescriptors(selection) {
    if (selection.length === 0) return [];
    const first = /** @type {PropertyDescriptor[]} */ (sortByPropertyOrder(selection[0].getPropertyDescriptors(), descriptorOrderKey));
    if (selection.length === 1) return first;

    const descriptors = selection.map(s => /** @type {PropertyDescriptor[]} */ (s.getPropertyDescriptors()));
    const lockDescriptor = descriptors.flat().find(item => item.key === 'locked');
    const merged = first.some(desc => desc.key === 'locked') || !lockDescriptor ? first : [lockDescriptor, ...first];
    return sortByPropertyOrder(merged, descriptorOrderKey).flatMap(desc => {
        const matches = descriptors.map(list => list.find(item => item.key === desc.key));
        if (desc.key !== 'locked' && matches.some(item => !item)) return [];
        if (desc.type !== 'select' || !Array.isArray(desc.options)) return [desc];
        const options = desc.options.filter(/** @param {PropertyOption} option */ option =>
            matches.every(item => item && item.options?.some(/** @param {PropertyOption} other */ other => other.value === option.value)));
        if (!options.length) return [];
        return [{ ...desc, options: options.map(option =>
            desc.key === 'packageId' && option.value === 'default'
                ? { ...option, label: 'Default package' } : option) }];
    });
}

/**
 * Canonical-order key of a descriptor; `orderKey` lets a property sort as a related one.
 * @param {PropertyDescriptor|(PropertyField & {orderKey?: string})} desc
 */
const descriptorOrderKey = desc => desc.orderKey || desc.key;

/** @param {SchematicItem[]} selection */
function headerLabel(selection) {
    if (selection.length === 0) return 'Properties';
    /** @type {Record<string, string>} */
    const displayNames = { rect: 'Rectangle', text: 'Text', Net: 'Net', noconnect: 'No Connect', polyline: 'Line' };
    const types = selection.map(s => {
        if (isComponentItem(s)) return 'Component';
        if (isPolylineItem(s) && s.isRect) return 'rect';
        if (isPolylineItem(s) && s.closed) return 'polygon';
        return s.type || 'object';
    });
    const first = types[0];
    if (types.every(t => t === first)) {
        if (first === 'Component') {
            const names = new Set(selection.filter(isComponentItem).map(s => s.name).filter(Boolean));
            if (names.size === 1) return `Component - ${[...names][0].toUpperCase()}`;
            return 'Component';
        }
        return displayNames[first] || first.charAt(0).toUpperCase() + first.slice(1);
    }
    return 'Multiple';
}

/** @param {SchematicItem[]} selection */
const summaryText = selection => selection.length === 0 ? 'None selected'
    : selection.length === 1 ? '1 selected' : `${selection.length} selected`;

/**
 * Collect existing electrical net names for editable wire suggestions.
 * @param {SchematicEditor} app
 */
function wireNetNames(app) {
    return [...new Set((app.shapes || [])
        .filter(isWireOrNetItem)
        .map((shape) => String(shape.net || '').trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Append an editable Net field descriptor with a menu of current schematic nets.
 * @param {SchematicEditor} app @param {PropertyField[]} fields @param {string} id @param {string} value
 * @param {(net: string) => void} onChange
 * @param {{allowAuto?: boolean, isCurrent?: () => boolean, readOnly?: boolean, key?: string}} [options]
 */
function appendWireNetField(app, fields, id, value, onChange, {
    allowAuto = false, isCurrent = () => true, readOnly = false, key = 'net',
} = {}) {
    fields.push({
        key, prop: 'net', id, type: 'net', label: 'Net', value: value || '',
        placeholder: allowAuto ? 'Auto' : 'None', disabled: readOnly, nets: wireNetNames(app),
        commit: net => { if (isCurrent()) onChange(net); },
    });
}

const NEW_SHAPE_TOOLS = new Map([
    ['line', 'Line'],
    ['rect', 'Rectangle'],
    ['circle', 'Circle'],
    ['arc', 'Arc'],
    ['polygon', 'Polygon'],
    ['text', 'Text'],
    ['net', 'Net'],
    ['wire', 'Wire'],
    ['noconnect', 'No Connect'],
]);

/** @param {number} value @param {number} [min] @param {number} [max] */
const clamp = (value, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, value));
/** @param {number} value */
const round2 = value => Number(value.toFixed(2));
/** @param {PropertyContextSnapshot|null} a @param {PropertyContextSnapshot|null} b */
const sameContext = (a, b) => !!a && !!b
    && a.selection.length === b.selection.length
    && a.selection.every((item, index) => item === b.selection[index])
    && a.segmentShape === b.segmentShape && a.segmentEdge === b.segmentEdge
    && a.nodeShape === b.nodeShape && a.nodeId === b.nodeId;

/**
 * @param {SchematicItem[]} selection
 * @param {SelectedSegment|null} selectedSegment
 * @param {SelectedNode|null} selectedNode
 * @returns {PropertyContextSnapshot}
 */
function contextFor(selection, selectedSegment, selectedNode) {
    return {
        selection: [...selection],
        segmentShape: selectedSegment?.shape || null,
        segmentEdge: selectedSegment?.edgeId || null,
        nodeShape: selectedNode?.shape || null,
        nodeId: selectedNode?.nodeId || null,
    };
}

/** @param {SchematicEditor} app @param {PropertyContextSnapshot} context */
function editorState(app, context) {
    let state = propertyStates.get(app);
    if (!state) {
        state = { binding: createPropertyBinding(), context: null, previews: new Map(), isCurrent: () => false, generation: 0 };
        propertyStates.set(app, state);
    }
    if (!sameContext(state.context, context)) {
        state.context = context;
        state.previews = new Map();
    }
    return state;
}

/** @param {string|number} value */
function optionValue(value) {
    const numeric = parseFloat(String(value));
    return !Number.isNaN(numeric) && String(numeric) === String(value) ? numeric : value;
}

/** @param {SchematicItem[]} selection @param {string} key */
function valuesFor(selection, key) {
    return selection.map(item => propertyValue(item, key));
}

/** @template T @param {T[]} values @param {(a: T, b: T) => boolean} [equal] */
function allSame(values, equal = (a, b) => a === b) {
    return values.length > 0 && values.every(value => equal(value, values[0]));
}

/** @param {SchematicItem[]} selection @param {string} key @param {unknown} [empty] */
function scalarFieldValue(selection, key, empty = '') {
    const values = valuesFor(selection, key);
    const same = allSame(values);
    return { value: same ? values[0] ?? empty : empty, mixed: !same };
}

/**
 * @param {SchematicItem[]} selection
 * @param {string} key
 * @param {SelectedSegment|null} selectedSegment
 * @param {SelectedNode|null} selectedNode
 */
function numberValue(selection, key, selectedSegment, selectedNode) {
    if (key === 'bulge' && selectedSegment) {
        return { value: selectedSegment.shape.getEdgeAttr(selectedSegment.edgeId, 'bulge') || 0, mixed: false };
    }
    if (key === 'lineWidth' && selectedSegment) {
        return { value: selectedSegment.shape.getEdgeAttr(selectedSegment.edgeId, 'width'), mixed: false };
    }
    if (key === 'cornerRadius' && selectedNode) {
        return { value: selectedNode.shape.nodeCornerRadius(selectedNode.nodeId), mixed: false };
    }
    const values = valuesFor(selection, key).filter(/** @param {unknown} value @returns {value is number} */ value => typeof value === 'number');
    const same = allSame(values, (a, b) => Math.abs(a - b) < 1e-6);
    return { value: same ? values[0] : undefined, mixed: !same };
}

/** @param {SchematicEditor} app @param {SchematicItem[]} selection */
function selectedFocus(app, selection) {
    const segmentFocus = getShapeSegmentFocus(app);
    const selectedSegment = selection.length === 1
        && isPolylineItem(selection[0])
        && segmentFocus?.shapeId === selection[0].id
        && selection[0].edges.has(segmentFocus.edgeId)
        ? { shape: selection[0], edgeId: segmentFocus.edgeId }
        : null;
    const nodeFocus = getShapeNodeFocus(app);
    const selectedNode = selection.length === 1
        && isPolylineItem(selection[0])
        && nodeFocus?.shapeId === selection[0].id
        && selection[0].nodes.has(nodeFocus.nodeId)
        ? { shape: selection[0], nodeId: nodeFocus.nodeId }
        : null;
    return { selectedSegment, selectedNode };
}

/**
 * Describe drawing defaults in Properties before a geometric shape is placed.
 * @param {SchematicEditor} app
 * @param {string} tool
 * @param {() => boolean} isCurrent
 * @returns {PropertyPanel|null}
 */
function renderNewShapeProperties(app, tool, isCurrent) {
    const label = NEW_SHAPE_TOOLS.get(tool);
    if (!label) return null;
    const canEdit = () => isCurrent() && app.currentTool === tool;
    const options = /** @type {ToolOptions} */ (app.toolOptions || {});
    /** @param {string} key @param {unknown} value */
    const setOption = (key, value) => {
        if (!canEdit()) return;
        /** @type {ToolOptions} */ (app.toolOptions)[key] = value;
    };
    /**
     * @param {string} key
     * @param {string} id
     * @param {string} fieldLabel
     * @param {number} value
     * @param {{min: number, max: number, step: number}} limits
     * @returns {PropertyField}
     */
    const numberDefault = (key, id, fieldLabel, value, { min, max, step }) => ({
        key, id, type: 'number', label: fieldLabel, value, min, max, step,
        normalize: next => clamp(next, min, max),
        preview: next => setOption(key, clamp(next, min, max)),
        commit: next => setOption(key, clamp(next, min, max)),
        cancel: () => false,
    });
    /** @type {PropertyField[]} */
    const fields = [];
    if (tool === 'wire') {
        appendWireNetField(app, fields, 'prop_newWireNet', options.wireNet || '', net => {
            /** @type {ToolOptions} */ (app.toolOptions).wireNet = net;
        }, { allowAuto: true, isCurrent: canEdit });
    } else if (tool === 'text' || tool === 'net') {
        const key = tool === 'text' ? 'fontSize' : 'netFontSize';
        fields.push({ ...numberDefault(key, 'prop_newShapeFontSize', 'Text Size (mm)',
            options[key] ?? (tool === 'text' ? 2 : 1.4), { min: 0.5, max: 50, step: 0.5 }), prop: 'fontSize' });
        if (tool === 'text') {
            fields.push({
                key: 'orientation', id: 'prop_newTextOrientation', type: 'select', label: 'Orientation',
                value: String(options.textRotation ?? 0),
                options: [0, 90, 180, 270].map(rotation => ({ value: String(rotation), label: `${rotation}\u00b0` })),
                commit: value => setOption('textRotation', Number(value)),
            });
        }
    } else if (tool !== 'noconnect') {
        fields.push({
            key: 'fill', id: 'prop_newShapeFill', type: 'checkbox', label: 'Fill', value: !!options.fill,
            commit: value => { if (canEdit()) /** @type {ToolOptions} */ (app.toolOptions).fill = value; },
        });
        fields.push(numberDefault('lineWidth', 'prop_newShapeLineWidth', 'Line Width (mm)',
            options.lineWidth ?? 0.2, { min: 0.05, max: 5, step: 0.05 }));
    }
    return { title: `New ${label}`, summary: 'None selected', fields, actions: [] };
}

/** @param {PropertyDescriptor} desc @param {SchematicItem[]} affected @param {number} value */
function normalizeNumber(desc, affected, value) {
    let next = value;
    if (desc.key === 'rotation') next = ((Math.round(next) % 360) + 360) % 360;
    if (desc.min != null) next = Math.max(desc.min, next);
    if (desc.max != null) next = Math.min(desc.max, next);
    if (desc.key === 'lineWidth') {
        const circleLimit = Math.min(...affected.map(item => isCircleItem(item) ? item.radius : Infinity));
        next = Math.min(next, circleLimit);
    }
    if (['cornerRadius', 'bulge'].includes(desc.key)) next = round2(next);
    return next;
}

/** @param {PropertyDescriptor} desc @param {SelectedSegment|null} selectedSegment @param {SelectedNode|null} selectedNode */
function numberFieldKey(desc, selectedSegment, selectedNode) {
    if (selectedSegment && desc.key === 'lineWidth') return 'segmentLineWidth';
    if (selectedSegment && desc.key === 'bulge') return 'segmentBulge';
    if (selectedNode && desc.key === 'cornerRadius') return 'nodeCornerRadius';
    return desc.key;
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem[]} selection
 * @param {PropertyDescriptor} desc
 * @param {DescriptorContext} context
 * @returns {PropertyField}
 */
function createNumberField(app, selection, desc, context) {
    const { selectedSegment, selectedNode, singlePolyline, allLocked, state, isCurrentSelection } = context;
    const key = desc.key;
    const affected = key === 'bulge' && selectedSegment ? [selectedSegment.shape]
        : selection.filter(item => key in item && !isSchematicLocked(item));
    /** @param {SchematicItem} item @returns {item is Polyline|Circle|Arc} */
    const usesGeometryState = item => ['lineWidth', 'cornerRadius', 'diameter', 'bulge'].includes(key)
        && isGeometryStateItem(item);
    const geometryEdit = affected.some(usesGeometryState);
    const baseFieldKey = numberFieldKey(desc, selectedSegment, selectedNode);
    const fieldKey = `${baseFieldKey}@${state.generation || 0}`;
    const previewKey = `${baseFieldKey}:${selectedSegment?.edgeId || ''}:${selectedNode?.nodeId || ''}`;
    let preview = state.previews.get(previewKey);
    const readValue = () => numberValue(selection, key, selectedSegment, selectedNode);
    const refresh = () => { if (state.isCurrent()) app.updatePropertiesPanel(app.selection.getSelection()); };
    if (!preview) {
        preview = createPropertyPreview({
            binding: state.binding,
            isCurrent: () => state.isCurrent(),
            beforeCommit: () => {
                if (key === 'bulge' && selectedSegment
                    && Math.abs(selectedSegment.shape.getEdgeAttr(selectedSegment.edgeId, 'bulge') || 0) < BULGE_EPS) {
                    selectedSegment.shape.cleanGraph();
                }
            },
            capture: () => affected.map(item => usesGeometryState(item) ? item.captureState() : propertyValue(item, key)),
            restore: snapshot => {
                affected.forEach((item, index) => {
                    if (usesGeometryState(item)) applySchematicItemState(item, /** @type {import('../../core/schematic-state.js').SchematicItemState} */ (snapshot[index]));
                    else setPropertyValue(item, key, snapshot[index]);
                    item.invalidate?.();
                });
            },
            redraw: () => redrawPropertyPreview(selection, { renderScene: () => {
                app.renderShapes(false);
                const textEditShape = getSchematicTextEdit(app)?.shape;
                if (key === 'rotation' && textEditShape && affected.includes(textEditShape)) app.updateTextEditOverlay();
            } }),
            commit: (before, after, { rebuild = true } = {}) => {
                let structureChanged = false;
                if (geometryEdit) {
                    const batch = new BatchCommand(`Change ${key}`);
                    const replacements = new Map();
                    affected.forEach((item, index) => {
                        if (key === 'bulge' && item.type === 'arc'
                            && Math.abs(bulgeRatio(after[index].startPoint, after[index].endPoint, after[index].bulgePoint)) < BULGE_EPS) {
                            replacements.set(item, appendArcToLineCommand(app, batch, item, after[index]));
                        } else if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) {
                            batch.add(usesGeometryState(item) ? new ModifyShapeCommand(app, item, before[index], after[index])
                                : new ModifyPropertyCommand(app, [item], key, after[index]));
                        }
                    });
                    app.history.execute(batch);
                    if (selectedSegment && !selectedSegment.shape.edges.has(selectedSegment.edgeId)) setShapeSegmentFocus(app, null);
                    if (replacements.size) {
                        const nextSelection = selection.map(item => replacements.get(item) || item);
                        app.selection.clearSelection();
                        for (const item of nextSelection) app.selection.select(item, true);
                        setShapeSegmentFocus(app, null);
                        setShapeNodeFocus(app, null);
                    }
                    structureChanged = replacements.size > 0 || (key === 'bulge' && !!selectedSegment
                        && Math.abs(selectedSegment.shape.getEdgeAttr(selectedSegment.edgeId, 'bulge') || 0) < BULGE_EPS);
                } else {
                    app.history.execute(new ModifyPropertyCommand(app, affected, key, after[0]));
                    const textEditShape = getSchematicTextEdit(app)?.shape;
                    if (['fontSize', 'rotation'].includes(key) && textEditShape && affected.includes(textEditShape)) app.updateTextEditOverlay();
                }
                app.fileManager.setDirty(true);
                if (!structureChanged && !rebuild) refresh();
                else app.updatePropertiesPanel(app.selection.getSelection());
            },
        });
        state.previews.set(previewKey, preview);
    }
    const { value, mixed } = readValue();
    /** @param {number} raw */
    const previewValue = raw => {
        if (!isCurrentSelection()) return;
        const next = normalizeNumber(desc, affected, raw);
        preview.update(/** @param {import('./selection.js').ShapeState[]} before */ before => {
            if (key === 'bulge' && selectedSegment) {
                selectedSegment.shape.setEdgeAttr(selectedSegment.edgeId, 'bulge', next);
                selectedSegment.shape.isRect = selectedSegment.shape.isAxisAlignedRect();
            } else if (key === 'lineWidth' && singlePolyline) {
                if (selectedSegment) singlePolyline.setEdgeAttr(selectedSegment.edgeId, 'width', next);
                else {
                    singlePolyline.lineWidth = next;
                    for (const edge of singlePolyline.edges.values()) delete edge.width;
                    singlePolyline.invalidate();
                }
            } else if (key === 'cornerRadius' && selectedNode) {
                selectedNode.shape.setNodeCornerRadius(selectedNode.nodeId, next);
            } else affected.forEach((item, index) => {
                if (geometryEdit && key === 'diameter') applySchematicItemState(item, before[index]);
                setPropertyValue(item, key, next);
                if (isPolylineItem(item) && key === 'lineWidth') {
                    for (const edge of item.edges.values()) delete edge.width;
                }
                if (isPolylineItem(item) && key === 'cornerRadius') item.nodeCornerRadii = {};
                item.invalidate?.();
            });
        });
        refresh();
    };
    return {
        key: fieldKey, prop: descriptorOrderKey(desc), id: `prop_${key}`, type: 'number', label: desc.label,
        value, mixed, disabled: allLocked, min: desc.min, max: desc.max, step: desc.step,
        numberFormat: key === 'rotation' ? 'rotation' : undefined,
        format: ['cornerRadius', 'bulge'].includes(key) ? next => Number(next).toFixed(2) : undefined,
        normalize: next => normalizeNumber(desc, affected, next),
        preview: previewValue,
        commit: () => state.binding.commit({ rebuild: true }),
        cancel: () => {
            const changed = state.binding.cancel();
            refresh();
            return changed;
        },
    };
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem[]} selection
 * @param {PropertyDescriptor} desc
 * @param {DescriptorContext} context
 * @returns {PropertyField|null}
 */
function descriptorField(app, selection, desc, context) {
    const { allLocked, selectedSegment, selectedNode, applyProperty } = context;
    const disabled = allLocked && desc.key !== 'locked';
    const common = { key: desc.key, prop: descriptorOrderKey(desc), id: `prop_${desc.key}`, label: desc.label, disabled };
    if (desc.type === 'number') return createNumberField(app, selection, desc, context);
    if (desc.type === 'checkbox') {
        const values = desc.key === 'locked' ? selection.filter(hasOwnLock).map(s => s.locked) : valuesFor(selection, desc.key);
        const same = allSame(values);
        return { ...common, type: 'checkbox', value: same ? !!values[0] : false,
            mixed: !same, disabled, commit: value => applyProperty(desc.key, value) };
    }
    if (desc.type === 'text') {
        const { value, mixed } = scalarFieldValue(selection, desc.key, '');
        return { ...common, type: 'text', value: String(value ?? ''), mixed, disabled: disabled || !!desc.readonly,
            commit: value => applyProperty(desc.key, value) };
    }
    if (desc.type === 'select' && Array.isArray(desc.options)) {
        const { value, mixed } = scalarFieldValue(selection, desc.key, '');
        return { ...common, type: 'select', value, mixed, options: desc.options,
            commit: value => applyProperty(desc.key, optionValue(value)) };
    }
    return null;
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem[]} selection
 * @param {DescriptorContext} context
 * @returns {PropertyField[]}
 */
function describeFields(app, selection, context) {
    const { selectedSegment, selectedNode, singleWire, allLocked, applyProperty, isCurrentSelection, state } = context;
    const selectedNodePath = selectedNode ? selectedNode.shape.toEditablePath() : null;
    const showNodeCornerRadius = selectedNode && selectedNodePath && canRoundPathNode(selectedNodePath,
        Object.values(selectedNodePath.nodeIds).indexOf(selectedNode.nodeId));
    /** @type {PropertyField[]} */
    const fields = [];
    const descriptors = selectedNode
        ? (showNodeCornerRadius
            ? [{ key: 'cornerRadius', label: 'Corner Radius (mm)', type: 'number', min: 0, max: 25, step: 0.5 }] : [])
        : selectedSegment
            ? mergeDescriptors(selection).filter((desc) => desc.key === 'lineWidth')
            : mergeDescriptors(selection);
    const activeSegmentBulge = selectedSegment
        && state.previews.get(`segmentBulge:${selectedSegment.edgeId}:`)?.active;
    if (selectedSegment && (activeSegmentBulge
        || Math.abs(selectedSegment.shape.getEdgeAttr(selectedSegment.edgeId, 'bulge') || 0) >= BULGE_EPS)) {
        descriptors.push({ key: 'bulge', label: 'Bulge', type: 'number', min: -1, max: 1, step: 0.05 });
    }
    let netShown = !singleWire;
    const appendNet = () => {
        if (!singleWire) return;
        appendWireNetField(app, fields, 'prop_net', singleWire.net, net => {
            if (!net) {
                app.updatePropertiesPanel(selection);
                return;
            }
            applyProperty('net', net);
        }, { isCurrent: isCurrentSelection, readOnly: allLocked });
    };
    for (const desc of descriptors) {
        if (!netShown && propertyRank(descriptorOrderKey(desc)) > propertyRank('net')) {
            appendNet();
            netShown = true;
        }
        const field = descriptorField(app, selection, desc, context);
        if (field) fields.push(field);
    }
    if (!netShown) appendNet();
    const textShapes = selection.filter(isTextItem);
    if (textShapes.length > 0 && textShapes.length === selection.length) {
        const rotation = textShapes[0].rotation;
        const mixed = textShapes.some(text => text.rotation !== rotation);
        fields.push({
            key: 'orientation', id: 'propTextOrientation', type: 'select', label: 'Orientation',
            value: mixed ? '' : String(rotation),
            mixed, disabled: allLocked,
            options: [0, 90, 180, 270].map(angle => ({ value: String(angle), label: `${angle}\u00b0` })),
            commit: value => { if (isCurrentSelection() && value !== '') applyProperty('rotation', Number(value)); },
        });
    }
    return sortByPropertyOrder(fields, field => field.prop || field.key);
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} title
 * @param {() => void} run
 * @param {boolean} [disabled]
 * @returns {PropertyAction}
 */
function action(id, label, title, run, disabled = false) {
    return { id, label, title, disabled, run };
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem[]} selection
 * @param {() => boolean} isCurrent
 * @param {boolean} allLocked
 * @param {(key: string, value: unknown) => void} applyProperty
 * @returns {PropertyActionGroup[]}
 */
function _bindActionButtons(app, selection, isCurrent, allLocked, applyProperty) {
    if (selection.length === 0) return [];
    /** @type {PropertyActionGroup[]} */
    const groups = [{
        title: 'Clipboard',
        actions: [
            action('propCut', '✂ Cut', adaptShortcutText('Cut (Ctrl+X)'), () => { if (isCurrent()) cutSelection(app); }, allLocked),
            action('propCopy', '⧉ Copy', adaptShortcutText('Copy (Ctrl+C)'), () => { if (isCurrent()) app.copySelection(); }),
            action('propPaste', '📋 Paste', adaptShortcutText('Paste (Ctrl+V)'), () => { if (isCurrent()) beginPastePreview(app); }),
        ],
    }];
    const hasComponent = selection.some(isComponentItem);
    const netShapes = selection.filter(isNetItem);
    const hasNet = netShapes.length === selection.length && netShapes.length > 0;
    if (hasComponent || hasNet) {
        /** @type {PropertyAction[]} */
        const actions = [];
        if (hasNet) {
            actions.push(action('propNetRotateLeft', '↶ Rotate L', 'Rotate Left', () => {
                if (!isCurrent()) return;
                const cur = netShapes[0].orientation || 'E';
                applyProperty('orientation', rotateNetOrientation(rotateNetOrientation(rotateNetOrientation(cur))));
            }, allLocked));
            actions.push(action('propNetRotateRight', '↷ Rotate R', 'Rotate Right', () => {
                if (!isCurrent()) return;
                applyProperty('orientation', rotateNetOrientation(netShapes[0].orientation || 'E'));
            }, allLocked));
        }
        if (hasComponent) {
            // Locked parts are left alone (as in the PCB editor), so offer no transform.
            actions.push(action('propRotateLeft', '↶ Rotate L', 'Rotate Left', () => { if (isCurrent()) rotateComponentLeft(app); }, allLocked));
            actions.push(action('propRotateRight', '↷ Rotate R', 'Rotate Right', () => { if (isCurrent()) rotateComponentRight(app); }, allLocked));
            actions.push(action('propFlipH', '⇔ Flip H', 'Flip Horizontal', () => { if (isCurrent()) flipComponentH(app); }, allLocked));
            actions.push(action('propFlipV', '⇕ Flip V', 'Flip Vertical', () => { if (isCurrent()) flipComponentV(app); }, allLocked));
        }
        groups.push({ title: 'Transform', actions });
    }
    /** @type {PropertyAction[]} */
    const finalActions = [];
    const selectedComponent = selection.length === 1 && isComponentItem(selection[0]) ? selection[0] : null;
    if (selectedComponent && hasAny3DModel(selectedComponent.definition)) {
        finalActions.push(action('propShow3D', '🧊 Show 3D', 'Show 3D model', async () => {
            if (!isCurrent()) return;
            const sel = app.selection?.getSelection?.() || [];
            const comp = sel.length === 1 && isComponentItem(sel[0]) ? sel[0] : null;
            if (!comp) return;
            const modelData = comp.definition;
            if (!hasAny3DModel(modelData)) return;
            const title = comp.reference ? `${comp.reference} — 3D Model` : '3D Model';
            try {
                const ok = await openComponent3DFromData({ data: modelData, title });
                if (!ok) console.warn('No renderable 3D model found for component');
            } catch (err) {
                console.error('Failed to open 3D pop-out:', err);
            }
        }));
    }
    finalActions.push(action('ribbonDelete', '🗑 Delete', 'Delete (Del)', () => {
        if (isCurrent()) runSchematicDeleteAction(app);
    }, allLocked));
    groups.push({ title: 'Actions', actions: finalActions });
    return groups;
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem[]} selection
 * @returns {PropertyPanel}
 */
export function describePropertiesPanel(app, selection) {
    const { selectedSegment, selectedNode } = selectedFocus(app, selection);
    const context = contextFor(selection, selectedSegment, selectedNode);
    const state = editorState(app, context);
    const panel = /** @type {PropertiesPanelUi} */ (app.ui).propertiesPanel;
    const currentPanel = { binding: state.binding, previews: state.previews };
    if (panel) propertyPanels.set(panel, currentPanel);
    const isCurrentSelection = () => {
        if (/** @type {PropertiesPanelUi} */ (app.ui).propertiesPanel !== panel
            || propertyPanels.get(/** @type {HTMLElement} */ (panel)) !== currentPanel) return false;
        const current = app.selection.getSelection();
        return current.length === selection.length && current.every((item, index) => item === selection[index]);
    };
    state.isCurrent = isCurrentSelection;
    if (selection.length === 0) {
        return renderNewShapeProperties(app, app.currentTool, isCurrentSelection)
            || { title: headerLabel(selection), summary: summaryText(selection), fields: [], actions: [] };
    }
    /** @param {string} key @param {unknown} value */
    const applyProperty = (key, value) => {
        if (isCurrentSelection()) applyCommonProperty(app, key, value);
    };
    const singleWire = selection.length === 1 && isWireItem(selection[0]) ? selection[0] : null;
    const singlePolyline = selection.length === 1 && isPolylineItem(selection[0]) ? selection[0] : null;
    const allLocked = selection.length > 0 && selection.every(isSchematicLocked);
    const title = selectedNode ? 'Node' : selectedSegment
        ? `${Math.abs(selectedSegment.shape.getEdgeAttr(selectedSegment.edgeId, 'bulge') || 0) >= BULGE_EPS ? 'Arc' : 'Line'}${selectedSegment.shape.edges.size === 1 ? '' : ' Segment'}`
        : headerLabel(selection);
    const descriptorContext = {
        selectedSegment, selectedNode, singleWire, singlePolyline, allLocked, state,
        isCurrentSelection, applyProperty,
    };
    return {
        title,
        summary: summaryText(selection),
        fields: describeFields(app, selection, descriptorContext),
        actions: _bindActionButtons(app, selection, isCurrentSelection, allLocked, applyProperty),
    };
}

// ── panel rendering ──────────────────────────────────────────────

/**
 * Rebuilds the properties panel from a description: merged property descriptors,
 * clipboard actions, transform buttons, and delete.
 * @param {SchematicEditor} app
 * @param {SchematicItem[]} selection - Currently selected shapes/components.
 */
export function updatePropertiesPanel(app, selection) {
    const panel = /** @type {PropertiesPanelUi} */ (app.ui).propertiesPanel;
    if (!panel) return;
    renderSchematicPropertyPanel(panel, describePropertiesPanel(app, selection));
}

// ── property application ─────────────────────────────────────────

/**
 * Applies a property value change to all selected items via
 * `ModifyPropertyCommand`, with duplicate reference validation for components.
 * @param {SchematicEditor} app
 * @param {string} prop - Property key to modify.
 * @param {*} value - New value for the property.
 */
export function applyCommonProperty(app, prop, value) {
    if (propertyStates.get(app)?.binding.prepare() === false) return;
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    const affected = selection.filter(item => prop in item
        && (prop === 'locked' ? hasOwnLock(item) : !isSchematicLocked(item)));
    if (affected.length === 0) return;

    const changing = affected.filter(item => propertyValue(item, prop) !== value);
    if (changing.length === 0) return;

    if (prop === 'packageId' && changing.some(item => !/** @type {PropertyDescriptor[]} */ (item.getPropertyDescriptors())
        .find(desc => desc.key === prop)?.options?.some(/** @param {PropertyOption} option */ option => option.value === value))) {
        app.alert('Choose a package supported by every selected component.', { title: 'Incompatible Package' });
        app.updatePropertiesPanel(selection);
        return;
    }

    if (prop === 'reference' && value) {
        const duplicate = app.components.find(c =>
            c.reference.toUpperCase() === value.toUpperCase() && !changing.includes(c));
        if (duplicate) {
            app.alert(`Reference "${value}" is already used by another component.`, { title: 'Duplicate Reference' });
            app.updatePropertiesPanel(selection);
            return;
        }
    }
    if (prop === 'text') {
        const refFields = changing.filter(isReferenceTextField);
        if (refFields.length > 0 && value) {
            const parentIds = new Set(refFields.map(f => f.parentComponent.id).filter(Boolean));
            const duplicate = app.components.find(c =>
                c.reference.toUpperCase() === value.toUpperCase() && !parentIds.has(c.id));
            if (duplicate) {
                app.alert(`Reference "${value}" is already used by another component.`, { title: 'Duplicate Reference' });
                app.updatePropertiesPanel(selection);
                return;
            }
        }
        const wireLabelFields = changing.filter(isWireLabelTextField);
        if (wireLabelFields.length > 0 && value) {
            const parentWireIds = new Set(wireLabelFields.map(f => f.parentComponent.id).filter(Boolean));
            const dup = app.shapes.find(s =>
                isWireItem(s) && !parentWireIds.has(s.id) &&
                s.wireLabel.toUpperCase() === value.toUpperCase());
            if (dup) {
                app.alert(`Wire name "${value}" is already used by another wire.`, { title: 'Duplicate Wire Name' });
                app.updatePropertiesPanel(selection);
                return;
            }
        }
    }

    if (prop === 'wireLabel' && value) {
        const changingIds = new Set(changing.map(s => s.id));
        const dup = app.shapes.find(s =>
            isWireItem(s) && !changingIds.has(s.id) &&
            s.wireLabel.toUpperCase() === value.toUpperCase());
        if (dup) {
            app.alert(`Wire name "${value}" is already used by another wire.`, { title: 'Duplicate Wire Name' });
            app.updatePropertiesPanel(selection);
            return;
        }
    }

    const command = new ModifyPropertyCommand(app, changing, prop, value);
    app.history.execute(command);

    app.fileManager.setDirty(true);
    app.updatePropertiesPanel(selection);
    const textEdit = getSchematicTextEdit(app);
    if (prop === 'fontSize' && textEdit?.shape && selection.includes(textEdit.shape)) {
        app.updateTextEditOverlay();
    }
    if (prop === 'locked' && value) app.endTextEdit(true);
}
