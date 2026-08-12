import { isLayerLocked, isLayerVisible } from './layers.js';
import { pcbTextBounds, pcbTextHitTest, renderPcbText } from './pcb-text.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';

export function createPcbTextSelectionAdapter(app, text, id) {
    return {
        id,
        kind: 'text',
        object: text,
        get visible() { return !isLayerLocked(text.layer) && isLayerVisible(text.layer); },
        getBounds() { return pcbTextBounds(text); },
        hitTest(point) { return pcbTextHitTest(text, point.x, point.y); },
        getPosition() { return { x: text.x, y: text.y }; },
        beginMove(worldPos) { return app._beginTextDrag(text, worldPos); },
        updateMove(worldPos) { app._updateTextDrag(worldPos); },
        endMove(commit) { if (commit) app._endTextDrag(); },
        invalidate() { app._refreshText(text.id); },
        render() { renderPcbText(text); },
    };
}

registerPcbSelectionAdapter('text', createPcbTextSelectionAdapter);
