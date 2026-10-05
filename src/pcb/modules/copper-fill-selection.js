import { createBoardShapeSelectionAdapter } from './board-shapes.js';
import { fillEditProfile } from './copper-fill-edit.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';

export function createCopperFillSelectionAdapter(app, fill, id) {
    return createBoardShapeSelectionAdapter(app, fill, id, fillEditProfile());
}

registerPcbSelectionAdapter('fill', createCopperFillSelectionAdapter);
