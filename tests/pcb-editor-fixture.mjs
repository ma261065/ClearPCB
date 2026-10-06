/**
 * Shared fixture for tests that exercise real PCBApp methods instead of evaluating
 * sliced source text. The editor uses the real prototype, a real PcbDocument and the
 * editor's real undo history (with the lock gate, built by the same createPcbHistory);
 * only presentation side effects that a headless test does not observe (status
 * bar, SVG layer groups, overlays) are quiet by default. Tests override what they
 * observe through `overrides`.
 *
 * Install DOM globals (window, document, localStorage, ...) before importing this
 * module, because PCBApp's module graph reads some of them at load time.
 */
import { PcbDocument } from '../src/core/PcbDocument.js';

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { createPcbHistory } = await import('../src/pcb/modules/object-locks.js');
export { PCBApp };

const quiet = () => {};

function fakeSvgGroup() {
    return {
        attributes: new Map(), children: [], style: {}, dataset: {}, parentNode: null,
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) {
            child.parentNode?.removeChild?.(child);
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            this.children = this.children.filter(item => item !== child);
            child.parentNode = null;
            return child;
        },
        remove() { this.parentNode?.removeChild?.(this); },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        querySelectorAll(selector) {
            const matches = child => selector.startsWith('.')
                && (child.getAttribute?.('class') || '').split(' ').includes(selector.slice(1));
            return this.children.flatMap(child => [
                ...(matches(child) ? [child] : []),
                ...(child.querySelectorAll?.(selector) || []),
            ]);
        },
    };
}

export function pcbEditorFixture(overrides = {}) {
    const editor = Object.create(PCBApp.prototype);
    const layerGroups = new Map();
    const own = {
        pcbDocument: new PcbDocument(),
        placements: new Map(),
        viewport: { scale: 10, svg: { style: {} } },
        status: {},
        getLayerGroup(id) {
            if (!layerGroups.has(id)) layerGroups.set(id, fakeSvgGroup());
            return layerGroups.get(id);
        },
        screenToWorld(event) { return { x: event.clientX, y: event.clientY }; },
        snapToGrid(point) { return { x: point.x, y: point.y }; },
        // A real editor always has its layer-group map (existingLayerGroups()).
        _layerGroups: layerGroups,
        setPcbStatus: quiet,
        _drawRefOverlay: quiet,
        _refreshPcbSelectionHighlights: quiet,
        ...overrides,
    };
    // Own data properties shadow prototype accessors (some model getters have no setter).
    for (const [key, value] of Object.entries(own)) {
        Object.defineProperty(editor, key, { value, writable: true, configurable: true, enumerable: true });
    }
    if (!('history' in own)) {
        Object.defineProperty(editor, 'history', { value: createPcbHistory(editor), writable: true, configurable: true, enumerable: true });
    }
    return editor;
}
