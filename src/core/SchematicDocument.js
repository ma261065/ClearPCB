import { Component, updateComponentIdCounter } from '../components/Component.js';
import { BuiltInComponents } from '../components/BuiltInComponents.js';
import { createShape, updateIdCounter, resetWireLabelCounter, resetNetNameCounter } from '../shapes/index.js';
import { bumpWireLabelCounter, bumpNetNameCounter } from '../shapes/wire.js';
import { validateEditableProject } from './project-format.js';
import { compactProjectAliases } from './project-field-aliases.js';
import { extractNetlist } from './netlist.js';

/** @typedef {import('./ProjectDocument.js').ProjectData} ProjectData */
/** @typedef {import('../shapes/wire.js').Wire | import('../shapes/net.js').Net | import('../shapes/text.js').Text | import('../shapes/polyline.js').Polyline | import('../shapes/circle.js').Circle | import('../shapes/arc.js').Arc | import('../shapes/noconnect.js').NoConnect | import('../components/Component.js').Component} SchematicItem */
/**
 * A schematic shape: one of the shape classes (wire, net label, text, polyline, circle,
 * arc, no-connect) or a component, read through the Shape base class plus the fields its
 * subclass adds.
 * Transitional: modules move to SchematicItem; see docs/developer-guide.md handover.
 * @typedef {(import('../shapes/shape.js').Shape | import('../components/Component.js').Component) & {[key: string]: any}} SchematicShape
 */

/** @param {string} name */
const builtInDefinition = name => BuiltInComponents.find(definition => definition.name === name);

/** Construct component data without creating its SVG. */
/**
 * @param {ProjectData} data
 * @param {(name: string) => any} [getDefinition]
 */
export function deserializeComponent(data, getDefinition = builtInDefinition) {
    const embedded = data.def;
    const definition = embedded ? structuredClone(embedded) : getDefinition(data.dn);
    if (!definition) {
        console.warn('Component definition not found:', data.dn);
        return null;
    }
    if (embedded && (!definition._source || definition._source === 'Built-in')) definition._source = 'Project';
    if (embedded && !definition.symbol && (definition.graphics || definition.pins)) {
        definition.symbol = {
            width: definition.width || 10, height: definition.height || 10,
            origin: definition.origin || { x: 5, y: 5 },
            graphics: definition.graphics || [], pins: definition.pins || [],
        };
    }
    return new Component(definition, {
        id: data.id, x: data.x, y: data.y, rotation: data.rot ?? 0,
        mirror: data.mir ?? false, reference: data.ref, value: data.val,
        packageId: data.pkg, showReference: data.sr, showValue: data.sv,
        properties: data.props, visible: data.v, locked: data.lk,
    });
}

/** Shared data mutation for project commands and schematic property edits. */
/**
 * @param {Component} component
 * @param {string} reference
 */
export function setComponentReference(component, reference) {
    component.reference = reference;
    if (component.refText) component.refText.text = reference;
}

/** Serialize authored entities with detached preferences and deduplicated definitions. */
/** @param {{shapes: SchematicShape[], components: Component[], settings?: object}} value */
export function serializeSchematicDocument({ shapes, components, settings = {} }) {
    const serializedComponents = components.map(component => component.toJSON());
    const serializedShapes = shapes
        .filter(shape => !(shape.type === 'text' && shape.fieldKey === 'net' && shape.parentComponent?.type === 'net'))
        .map(shape => shape.toJSON());
    /** @type {Record<string, any>} */
    const defs = {};
    for (const component of serializedComponents) {
        if (component.def && component.dn) {
            if (!defs[component.dn]) defs[component.dn] = component.def;
            delete component.def;
        }
    }
    /** @type {{settings: object, shapes: any[], components: Record<string, any>[], defs?: Record<string, any>}} */
    const schematic = { settings, shapes: serializedShapes, components: serializedComponents };
    if (Object.keys(defs).length) schematic.defs = defs;
    return compactProjectAliases({
        version: '1.0', type: 'clearpcb-project', created: new Date().toISOString(), schematic,
    });
}

/**
 * Project-owned schematic state. Existing entities retain their presentation
 * methods during migration; none of this model's operations invoke them.
 */
export class SchematicDocument {
    constructor() {
        /** @type {SchematicShape[]} */
        this.shapes = [];
        /** @type {Component[]} */
        this.components = [];
        this.settings = {};
    }

    /** Validate and construct a replacement without changing the live collections. */
    /**
     * @param {ProjectData} data
     * @param {(name: string) => any} [getDefinition]
     */
    prepare(data, getDefinition = builtInDefinition) {
        data = validateEditableProject(data);
        /** @type {{shapes: ProjectData[], components: ProjectData[], defs?: Record<string, ProjectData>, settings?: object}} */
        const schematic = data.schematic;
        const shapes = schematic.shapes.filter(item => item.fk !== 'net')
            .map(item => ({ data: item, shape: createShape(item) }));
        const components = schematic.components.map(item => {
            const component = deserializeComponent({ ...item, def: schematic.defs?.[item.dn] }, getDefinition);
            if (!component) throw new Error(`Missing component definition: ${item.dn}`);
            return component;
        });
        return { data, shapes, components };
    }

    /** Adopt prepared entities without cloning them or creating presentation state. */
    /**
     * @param {ProjectData} data
     * @param {{data: ProjectData, shapes: Array<{data: ProjectData, shape: SchematicShape}>, components: Component[]}} [prepared]
     */
    load(data, prepared = this.prepare(data)) {
        resetWireLabelCounter();
        resetNetNameCounter();
        this.shapes = prepared.shapes.map(({ data: item, shape }) => {
            if (item.id) updateIdCounter(item.id);
            if (shape.type === 'wire') bumpWireLabelCounter(shape.wireLabel);
            if (shape.net) bumpNetNameCounter(shape.net);
            if (item.cid && item.fk) {
                shape._pendingComponentId = item.cid;
                shape.fieldKey = item.fk;
            }
            return shape;
        });
        this.components = prepared.components;
        this.settings = structuredClone(prepared.data.schematic.settings || {});
        for (const component of this.components) {
            updateComponentIdCounter(component.id);
            component.linkFieldTexts(this.shapes);
        }
        const targets = new Map([...this.shapes, ...this.components].map(item => [item.id, item]));
        for (const shape of this.shapes) {
            if (shape.type !== 'text' || shape.fieldKey !== 'label' || !shape._pendingComponentId) continue;
            const target = targets.get(shape._pendingComponentId);
            if (!target) continue;
            shape.parentComponent = target;
            if (!(target.attachedLabels instanceof Set)) target.attachedLabels = new Set();
            target.attachedLabels.add(shape);
        }
    }

    clear() {
        this.shapes = [];
        this.components = [];
        this.settings = {};
    }

    /** Current view preferences override the loaded fallback for this snapshot only. */
    /** @param {object} [settings] */
    serialize(settings = this.settings) {
        return serializeSchematicDocument({ shapes: this.shapes, components: this.components, settings });
    }

    /**
     * @returns {import('./ProjectDocument.js').ComponentInfo|null}
     * @param {string} id
     */
    getComponentInfo(id) {
        const component = this.components.find(item => item.id === id);
        if (!component) return null;
        const shapes = component.definition?.footprintShapes;
        return { id: component.id, reference: component.reference, locked: !!component.locked,
            footprintShapes: Array.isArray(shapes) ? shapes.filter(shape => typeof shape === 'string') : [] };
    }

    /**
     * @param {string} id
     * @param {string} reference
     */
    validateComponentReference(id, reference) {
        const component = this.components.find(item => item.id === id);
        if (!component) return { message: 'Component is no longer available.', title: 'Invalid Reference' };
        if (component.locked) return { message: 'Component is locked.', title: 'Locked Component' };
        reference = reference.trim();
        if (!reference) return { message: 'Reference cannot be blank.', title: 'Invalid Reference' };
        if (this.components.some(item => item.id !== id && item.reference.toUpperCase() === reference.toUpperCase())) {
            return { message: `Reference "${reference}" is already used by another component.`, title: 'Duplicate Reference' };
        }
        return null;
    }

    /**
     * @param {string} id
     * @param {string} reference
     */
    createReferenceRenameCommand(id, reference) {
        const issue = this.validateComponentReference(id, reference);
        if (issue) throw new Error(issue.message);
        const original = (/** @type {import('./ProjectDocument.js').ComponentInfo} */ (this.getComponentInfo(id))).reference;
        /** @param {string} value */
        const apply = value => {
            const component = this.components.find(item => item.id === id);
            if (!component) throw new Error('Component is no longer available.');
            setComponentReference(component, value);
        };
        reference = reference.trim();
        return { execute: () => apply(reference), undo: () => apply(original) };
    }

    getNetlist() {
        return extractNetlist(this);
    }
}
