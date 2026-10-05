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

export function pcbEditorFixture(overrides = {}) {
    const editor = Object.create(PCBApp.prototype);
    const own = {
        pcbDocument: new PcbDocument(),
        placements: new Map(),
        viewport: { scale: 10, svg: { style: {} } },
        status: {},
        getLayerGroup: () => null,
        // A real editor always has its layer-group map (existingLayerGroups()).
        _layerGroups: new Map(),
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
