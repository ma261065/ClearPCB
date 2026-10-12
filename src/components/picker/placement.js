/**
 * ComponentPicker placement hand-off owner. Normalizes the selected definition and emits placement events.
 */

import { normalizeDefinition, updatePreview } from './symbol-preview.js';
import { setPlaceBtnLoading, setPreviewLoading } from './ui-state.js';

/** @typedef {import('../ComponentPicker.js').ComponentPicker} ComponentPicker */
/** @typedef {import('../ComponentPicker.js').PickerComponentDefinition} PickerComponentDefinition */

/**
 * Begins component placement by emitting a selection event.
 * @param {PickerComponentDefinition|null|undefined} definition - The normalized component definition.
 * @param {Object} [options] - Placement options.
 * @param {boolean} [options.skipFootprint3d] - Whether to skip footprint/3D preview updates.
 */
export function beginPlacement(/** @type {ComponentPicker} */ picker, definition, options = {}) {
    if (!definition) return;
    picker.selectedComponent = /** @type {PickerComponentDefinition} */ (normalizeDefinition(picker, definition));
    updatePreview(picker, picker.selectedComponent, { skipFootprint3d: !!options.skipFootprint3d });

    setPlaceBtnLoading(picker, 'Place Component', false, true);
    setPreviewLoading(picker, null);

    picker.eventBus.emit('component:selected', picker.selectedComponent);
}
