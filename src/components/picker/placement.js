/**
 * ComponentPicker placement hand-off owner. Normalizes the selected definition and emits placement events.
 */

import { normalizeDefinition, updatePreview } from './symbol-preview.js';
import { setPlaceBtnLoading, setPreviewLoading } from './ui-state.js';

/**
 * Begins component placement by emitting a selection event.
 * @param {Object} definition - The normalized component definition.
 * @param {Object} [options] - Placement options.
 * @param {boolean} [options.skipFootprint3d] - Whether to skip footprint/3D preview updates.
 */
export function beginPlacement(/** @type {any} */ picker, definition, options = {}) {
    if (!definition) return;
    picker.selectedComponent = normalizeDefinition(picker, definition);
    updatePreview(picker, picker.selectedComponent, { skipFootprint3d: !!options.skipFootprint3d });

    setPlaceBtnLoading(picker, 'Place Component', false, true);
    setPreviewLoading(picker, null);

    picker.eventBus.emit('component:selected', picker.selectedComponent);
}
