/**
 * Quiet stand-ins for the PCB editor methods that modules call, for tests that build a
 * plain-object editor instead of using pcbEditorFixture(). Modules call these methods
 * directly (test-pcb-editor-api forbids `app.method?.()`), so a fake needs every one it
 * reaches. Each stub returns undefined, except netNames, which lists the nets of the
 * fake's collections like the editor does. Spread the stubs first and override what a
 * test observes: `{ ...pcbEditorStubs(), setPcbStatus: message => messages.push(message) }`.
 */
import { PCB_EDITOR_SERVICES } from '../../../src/pcb/modules/pcb-editor-api.js';

/** Editor methods modules call that are not in the service list. */
const MODULE_CALLED_METHODS = [
    'syncPcbHistoryButtons', 'showClearances', 'isSectionEditing', 'drawRefOverlay', 'rerenderRef',
    'currentBoardView', 'canCopyCutPcbSelection', 'hasPcbClipboardData', 'open2DView', 'last2DSide',
    'open3DView', 'canUndoPcbHistory', 'cutSelection', 'copySelection', 'pasteSelection',
    'runAutoRoute', 'clearRoutes', 'showRefProperties',
];

const quiet = () => undefined;

/** @returns {Record<string, Function>} */
export function pcbEditorStubs() {
    const stubs = Object.fromEntries([...PCB_EDITOR_SERVICES, ...MODULE_CALLED_METHODS].map(name => [name, quiet]));
    stubs.netNames = function netNames() {
        const names = new Set((this.netlist || []).map(entry => String(entry.net || '')).filter(Boolean));
        for (const source of [this.tracks, this.vias, this.pads, this.boardShapes, this.copperFills]) {
            for (const item of source || []) {
                const net = String(item?.net || '');
                if (net) names.add(net);
            }
        }
        return [...names].sort();
    };
    return stubs;
}
