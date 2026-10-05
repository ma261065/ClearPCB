import { propertyRank, sortByPropertyOrder } from '../../shared/ui/property-order.js';
import { ModifyPropertyCommand, ModifyShapeCommand, BatchCommand } from './commands.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { bulgeRatio } from '../../core/geometry.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { adaptShortcutText } from './platform-keys.js';
import { canDecomposeRoundedCorners } from '../../shapes/shape-decompose.js';
import { decomposeShapeCorners, appendArcToLineCommand } from './context-menu.js';
import { hasAny3DModel, openComponent3DFromData } from '../../components/model3d-source.js';
import { redrawPropertyPreview, createPropertyPreview, createPropertyBinding } from '../../shapes/property-preview.js';
import { canRoundPathNode } from '../../shapes/path-geometry.js';
import { beginPastePreview, cutSelection } from './clipboard.js';
import { flipComponentH, flipComponentV, rotateComponentLeft, rotateComponentRight } from './components.js';
import { hasOwnLock, isSchematicLocked } from '../../shapes/lock-owner.js';
import { runSchematicDeleteAction } from './editor-actions.js';
import { getShapeNodeFocus, getShapeSegmentFocus, setShapeNodeFocus, setShapeSegmentFocus } from './shape-focus.js';
import { renderSchematicPropertyPanel } from './property-host.js';

/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */

const propertyPanels = new WeakMap();
const propertyStates = new WeakMap();

export function hasSchematicPropertyPreview(app) {
    return !!propertyStates.get(app)?.binding.active;
}

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
 * @param {object} app - Application state.
 */
export function bindPropertiesPanel(app) {
    if (!app.ui.propertiesPanel) return;

    updatePropertiesPanel(app, []);

    app.eventBus.on('selectionChanged', (shapes) => {
        updatePropertiesPanel(app, shapes);
    });
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * Compute the intersection of property descriptors across all selected items.
 * Only properties declared by *every* item in the selection are shown.
 */
export function mergeDescriptors(selection) {
    if (selection.length === 0) return [];
    const first = sortByPropertyOrder(selection[0].getPropertyDescriptors(), descriptorOrderKey);
    if (selection.length === 1) return first;

    const descriptors = selection.map(s => s.getPropertyDescriptors());
    const lockDescriptor = descriptors.flat().find(item => item.key === 'locked');
    const merged = first.some(desc => desc.key === 'locked') || !lockDescriptor ? first : [lockDescriptor, ...first];
    return sortByPropertyOrder(merged, descriptorOrderKey).flatMap(desc => {
        const matches = descriptors.map(list => list.find(item => item.key === desc.key));
        if (desc.key !== 'locked' && matches.some(item => !item)) return [];
        if (desc.type !== 'select' || !Array.isArray(desc.options)) return [desc];
        const options = desc.options.filter(option =>
            matches.every(item => item.options?.some(other => other.value === option.value)));
        if (!options.length) return [];
        return [{ ...desc, options: options.map(option =>
            desc.key === 'packageId' && option.value === 'default'
                ? { ...option, label: 'Default package' } : option) }];
    });
}

/** Canonical-order key of a descriptor; `orderKey` lets a property sort as a related one. */
const descriptorOrderKey = desc => desc.orderKey || desc.key;

function headerLabel(selection) {
    if (selection.length === 0) return 'Properties';
    const displayNames = { rect: 'Rectangle', text: 'Label', Net: 'Net', noconnect: 'No Connect', polyline: 'Line' };
    const types = selection.map(s => {
        if (s.definition) return 'Component';
        if (s.type === 'polyline' && s.isRect) return 'rect';
        if (s.type === 'polyline' && s.closed) return 'polygon';
        return s.type || 'object';
    });
    const first = types[0];
    if (types.every(t => t === first)) {
        if (first === 'Component') {
            const names = new Set(selection.map(s => s.name).filter(Boolean));
            if (names.size === 1) return `Component - ${[...names][0].toUpperCase()}`;
            return 'Component';
        }
        return displayNames[first] || first.charAt(0).toUpperCase() + first.slice(1);
    }
    return 'Multiple';
}

const summaryText = selection => selection.length === 0 ? 'None selected'
    : selection.length === 1 ? '1 selected' : `${selection.length} selected`;

/** Collect existing electrical net names for editable wire suggestions. */
function wireNetNames(app) {
    return [...new Set((app.shapes || [])
        .filter((shape) => shape?.type === 'wire' || shape?.type === 'net')
        .map((shape) => String(shape.net || '').trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Append an editable Net field descriptor with a menu of current schematic nets.
 * @param {any} app @param {PropertyField[]} fields @param {string} id @param {string} value
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

const clamp = (value, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, value));
const round2 = value => Number(value.toFixed(2));
const sameContext = (a, b) => !!a && !!b
    && a.selection.length === b.selection.length
    && a.selection.every((item, index) => item === b.selection[index])
    && a.segmentShape === b.segmentShape && a.segmentEdge === b.segmentEdge
    && a.nodeShape === b.nodeShape && a.nodeId === b.nodeId;

function contextFor(selection, selectedSegment, selectedNode) {
    return {
        selection: [...selection],
        segmentShape: selectedSegment?.shape || null,
        segmentEdge: selectedSegment?.edgeId || null,
        nodeShape: selectedNode?.shape || null,
        nodeId: selectedNode?.nodeId || null,
    };
}

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

function optionValue(value) {
    const numeric = parseFloat(value);
    return !Number.isNaN(numeric) && String(numeric) === String(value) ? numeric : value;
}

function valuesFor(selection, key) {
    return selection.map(item => item[key]);
}

function allSame(values, equal = (a, b) => a === b) {
    return values.length > 0 && values.every(value => equal(value, values[0]));
}

function scalarFieldValue(selection, key, empty = '') {
    const values = valuesFor(selection, key);
    const same = allSame(values);
    return { value: same ? values[0] ?? empty : empty, mixed: !same };
}

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
    const values = valuesFor(selection, key).filter(value => typeof value === 'number');
    const same = allSame(values, (a, b) => Math.abs(a - b) < 1e-6);
    return { value: same ? values[0] : undefined, mixed: !same };
}

function selectedFocus(app, selection) {
    const segmentFocus = getShapeSegmentFocus(app);
    const selectedSegment = selection.length === 1
        && selection[0].type === 'polyline'
        && segmentFocus?.shapeId === selection[0].id
        && selection[0].edges?.has(segmentFocus.edgeId)
        ? { shape: selection[0], edgeId: segmentFocus.edgeId }
        : null;
    const nodeFocus = getShapeNodeFocus(app);
    const selectedNode = selection.length === 1
        && selection[0].type === 'polyline'
        && nodeFocus?.shapeId === selection[0].id
        && selection[0].nodes?.has(nodeFocus.nodeId)
        ? { shape: selection[0], nodeId: nodeFocus.nodeId }
        : null;
    return { selectedSegment, selectedNode };
}

/**
 * Describe drawing defaults in Properties before a geometric shape is placed.
 * @returns {PropertyPanel|null}
 */
function renderNewShapeProperties(app, tool, isCurrent) {
    const label = NEW_SHAPE_TOOLS.get(tool);
    if (!label) return null;
    const canEdit = () => isCurrent() && app.currentTool === tool;
    const options = app.toolOptions || {};
    const setOption = (key, value) => {
        if (!canEdit()) return;
        app.toolOptions[key] = value;
    };
    /** @returns {PropertyField} */
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
        appendWireNetField(app, fields, 'prop_newWireNet', options.wireNet, net => {
            app.toolOptions.wireNet = net;
        }, { allowAuto: true, isCurrent: canEdit });
    } else if (tool === 'text' || tool === 'net') {
        const key = tool === 'text' ? 'fontSize' : 'netFontSize';
        fields.push({ ...numberDefault(key, 'prop_newShapeFontSize', 'Text Size (mm)',
            options[key] ?? (tool === 'text' ? 2 : 1.4), { min: 0.5, max: 50, step: 0.5 }), prop: 'fontSize' });
    } else if (tool !== 'noconnect') {
        fields.push({
            key: 'fill', id: 'prop_newShapeFill', type: 'checkbox', label: 'Fill', value: !!options.fill,
            commit: value => { if (canEdit()) app.toolOptions.fill = value; },
        });
        fields.push(numberDefault('lineWidth', 'prop_newShapeLineWidth', 'Line Width (mm)',
            options.lineWidth ?? 0.2, { min: 0.05, max: 5, step: 0.05 }));
    }
    return { title: `New ${label}`, summary: 'None selected', fields, actions: [] };
}

function normalizeNumber(desc, affected, value) {
    let next = value;
    if (desc.key === 'rotation') next = ((Math.round(next) % 360) + 360) % 360;
    if (desc.min != null) next = Math.max(desc.min, next);
    if (desc.max != null) next = Math.min(desc.max, next);
    if (desc.key === 'lineWidth') {
        const circleLimit = Math.min(...affected.map(item => item.type === 'circle' ? item.radius : Infinity));
        next = Math.min(next, circleLimit);
    }
    if (['cornerRadius', 'bulge'].includes(desc.key)) next = round2(next);
    return next;
}

function numberFieldKey(desc, selectedSegment, selectedNode) {
    if (selectedSegment && desc.key === 'lineWidth') return 'segmentLineWidth';
    if (selectedSegment && desc.key === 'bulge') return 'segmentBulge';
    if (selectedNode && desc.key === 'cornerRadius') return 'nodeCornerRadius';
    return desc.key;
}

/** @returns {PropertyField} */
function createNumberField(app, selection, desc, context) {
    const { selectedSegment, selectedNode, singlePolyline, allLocked, state, isCurrentSelection } = context;
    const key = desc.key;
    const affected = key === 'bulge' && selectedSegment ? [selectedSegment.shape]
        : selection.filter(item => key in item && !isSchematicLocked(item));
    const usesGeometryState = item => ['lineWidth', 'cornerRadius', 'diameter', 'bulge'].includes(key)
        && ['polyline', 'circle', 'arc'].includes(item.type);
    const geometryEdit = affected.some(usesGeometryState);
    const baseFieldKey = numberFieldKey(desc, selectedSegment, selectedNode);
    const fieldKey = `${baseFieldKey}@${state.generation || 0}`;
    const previewKey = `${baseFieldKey}:${selectedSegment?.edgeId || ''}:${selectedNode?.nodeId || ''}`;
    let preview = state.previews.get(previewKey);
    const readValue = () => numberValue(selection, key, selectedSegment, selectedNode);
    const refresh = () => { if (state.isCurrent()) app.updatePropertiesPanel?.(app.selection.getSelection()); };
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
            capture: () => affected.map(item => usesGeometryState(item) ? item.captureState() : item[key]),
            restore: snapshot => {
                affected.forEach((item, index) => {
                    if (usesGeometryState(item)) item.applyState(snapshot[index]);
                    else item[key] = snapshot[index];
                    item.invalidate?.();
                });
            },
            redraw: () => redrawPropertyPreview(selection, { renderScene: () => {
                app.renderShapes(false);
                if (key === 'rotation' && affected.includes(app.textEdit?.shape)) app.updateTextEditOverlay?.();
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
                    if (['fontSize', 'rotation'].includes(key) && affected.includes(app.textEdit?.shape)) app.updateTextEditOverlay?.();
                }
                app.fileManager.setDirty(true);
                if (!structureChanged && !rebuild) refresh();
                else app.updatePropertiesPanel?.(app.selection.getSelection());
            },
        });
        state.previews.set(previewKey, preview);
    }
    const { value, mixed } = readValue();
    const previewValue = raw => {
        if (!isCurrentSelection()) return;
        const next = normalizeNumber(desc, affected, raw);
        preview.update(before => {
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
                if (geometryEdit && key === 'diameter') item.applyState(before[index]);
                item[key] = next;
                if (item.type === 'polyline' && key === 'lineWidth') {
                    for (const edge of item.edges.values()) delete edge.width;
                }
                if (item.type === 'polyline' && key === 'cornerRadius') item.nodeCornerRadii = {};
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

/** @returns {PropertyField|null} */
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

/** @returns {PropertyField[]} */
function describeFields(app, selection, context) {
    const { selectedSegment, selectedNode, singleWire, allLocked, applyProperty, isCurrentSelection, state } = context;
    const selectedNodePath = selectedNode ? selectedNode.shape.toEditablePath() : null;
    const showNodeCornerRadius = selectedNodePath && canRoundPathNode(selectedNodePath,
        Object.values(selectedNodePath.nodeIds).indexOf(selectedNode.nodeId));
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
        appendWireNetField(app, fields, 'prop_net', singleWire.net, net => {
            if (!net) {
                app.updatePropertiesPanel?.(selection);
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
    return sortByPropertyOrder(fields, field => field.prop || field.key);
}

function action(id, label, title, run, disabled = false) {
    return { id, label, title, disabled, run };
}

function _bindActionButtons(app, selection, isCurrent, allLocked, applyProperty) {
    if (selection.length === 0) return [];
    const groups = [{
        title: 'Clipboard',
        actions: [
            action('propCut', '✂ Cut', adaptShortcutText('Cut (Ctrl+X)'), () => { if (isCurrent()) cutSelection(app); }, allLocked),
            action('propCopy', '⧉ Copy', adaptShortcutText('Copy (Ctrl+C)'), () => { if (isCurrent()) app.copySelection(); }),
            action('propPaste', '📋 Paste', adaptShortcutText('Paste (Ctrl+V)'), () => { if (isCurrent()) beginPastePreview(app); }),
        ],
    }];
    const hasComponent = selection.some(s => s.definition);
    const hasNet = selection.every(s => s.type === 'net') && selection.length > 0;
    if (hasComponent || hasNet) {
        const actions = [];
        if (hasNet) {
            actions.push(action('propNetRotateLeft', '↶ Rotate L', 'Rotate Left', () => {
                if (!isCurrent()) return;
                const cur = selection[0].orientation || 'E';
                applyProperty('orientation', rotateNetOrientation(rotateNetOrientation(rotateNetOrientation(cur))));
            }, allLocked));
            actions.push(action('propNetRotateRight', '↷ Rotate R', 'Rotate Right', () => {
                if (!isCurrent()) return;
                applyProperty('orientation', rotateNetOrientation(selection[0].orientation || 'E'));
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
    const textShapes = selection.filter(s => s.type === 'text');
    if (textShapes.length > 0 && textShapes.length === selection.length
        && !mergeDescriptors(selection).some(desc => desc.key === 'rotation')) {
        groups.push({
            title: 'Orientation',
            actions: [
                action('propTextHorizontal', 'H', 'Horizontal', () => applyProperty('rotation', 0), allLocked),
                action('propTextVertical', 'V', 'Vertical (bottom to top)', () => applyProperty('rotation', 270), allLocked),
            ],
        });
    }
    const finalActions = [];
    if (selection.length === 1 && hasAny3DModel(selection[0].definition)) {
        finalActions.push(action('propShow3D', '🧊 Show 3D', 'Show 3D model', async () => {
            if (!isCurrent()) return;
            const sel = app.selection?.getSelection?.() || [];
            const comp = sel.length === 1 ? sel[0] : null;
            const modelData = comp?.definition;
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
    if (selection.length === 1 && selection[0].type === 'polyline' && !allLocked && canDecomposeRoundedCorners(selection[0])) {
        finalActions.push(action('propDecomposeCorners', '⌒ Decompose corners',
            'Convert rounded corners into editable arc edges', () => {
                if (!isCurrent()) return;
                const sel = app.selection?.getSelection?.() || [];
                if (sel.length === 1) decomposeShapeCorners(app, sel[0]);
            }));
    }
    finalActions.push(action('ribbonDelete', '🗑 Delete', 'Delete (Del)', () => {
        if (isCurrent()) runSchematicDeleteAction(app);
    }, allLocked));
    groups.push({ title: 'Actions', actions: finalActions });
    return groups;
}

/** @returns {PropertyPanel} */
export function describePropertiesPanel(app, selection) {
    const { selectedSegment, selectedNode } = selectedFocus(app, selection);
    const context = contextFor(selection, selectedSegment, selectedNode);
    const state = editorState(app, context);
    const panel = app.ui.propertiesPanel;
    const currentPanel = { binding: state.binding, previews: state.previews };
    if (panel) propertyPanels.set(panel, currentPanel);
    const isCurrentSelection = () => {
        if (app.ui.propertiesPanel !== panel || propertyPanels.get(panel) !== currentPanel) return false;
        const current = app.selection.getSelection();
        return current.length === selection.length && current.every((item, index) => item === selection[index]);
    };
    state.isCurrent = isCurrentSelection;
    if (selection.length === 0) {
        return renderNewShapeProperties(app, app.currentTool, isCurrentSelection)
            || { title: headerLabel(selection), summary: summaryText(selection), fields: [], actions: [] };
    }
    const applyProperty = (key, value) => {
        if (isCurrentSelection()) applyCommonProperty(app, key, value);
    };
    const singleWire = selection.length === 1 && selection[0].type === 'wire' ? selection[0] : null;
    const singlePolyline = selection.length === 1 && selection[0].type === 'polyline' ? selection[0] : null;
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
 * @param {object} app - Application state.
 * @param {Array} selection - Currently selected shapes/components.
 */
export function updatePropertiesPanel(app, selection) {
    const panel = app.ui.propertiesPanel;
    if (!panel) return;
    renderSchematicPropertyPanel(panel, describePropertiesPanel(app, selection));
}

// ── property application ─────────────────────────────────────────

/**
 * Applies a property value change to all selected items via
 * `ModifyPropertyCommand`, with duplicate reference validation for components.
 * @param {object} app - Application state.
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

    const changing = affected.filter(item => item[prop] !== value);
    if (changing.length === 0) return;

    if (prop === 'packageId' && changing.some(item => !item.getPropertyDescriptors()
        .find(desc => desc.key === prop)?.options?.some(option => option.value === value))) {
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
        const refFields = changing.filter(s => s.parentComponent && s.fieldKey === 'reference');
        if (refFields.length > 0 && value) {
            const parentIds = new Set(refFields.map(f => f.parentComponent.id));
            const duplicate = app.components.find(c =>
                c.reference.toUpperCase() === value.toUpperCase() && !parentIds.has(c.id));
            if (duplicate) {
                app.alert(`Reference "${value}" is already used by another component.`, { title: 'Duplicate Reference' });
                app.updatePropertiesPanel(selection);
                return;
            }
        }
        const wireLabelFields = changing.filter(s => s.parentComponent?.type === 'wire' && (s.fieldKey === 'wireLabel' || s.fieldKey === 'label'));
        if (wireLabelFields.length > 0 && value) {
            const parentWireIds = new Set(wireLabelFields.map(f => f.parentComponent.id));
            const dup = app.shapes.find(s =>
                s.type === 'wire' && !parentWireIds.has(s.id) &&
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
            s.type === 'wire' && !changingIds.has(s.id) &&
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
    if (prop === 'fontSize' && app.textEdit?.shape && selection.includes(app.textEdit.shape)) {
        app.updateTextEditOverlay?.();
    }
    if (prop === 'locked' && value) app.endTextEdit?.(true);
}
