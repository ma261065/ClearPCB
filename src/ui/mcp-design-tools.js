// mcp-design-tools.js - Editor-backed MCP reports (DRC, renders) for McpBridge.
//
// McpBridge lives in core and only sees the ProjectDocument; these services
// reach the live editors on its behalf.

import { isEditorActive, isEditorStale } from '../pcb/modules/pcb-editor-api.js';
import { pcbDesignRuleReport, renderPcbPng } from '../pcb/modules/design-report.js';
import { syncFromSchematic } from '../pcb/modules/schematic-sync.js';
import { cloneSchematicContentForRender, rasterizeSvgToPng } from '../shared/ui/export.js';

/** @typedef {import('./PCBApp.js').default} PCBApp */
/** @typedef {import('./SchematicApp.js').default} SchematicApp */
/** @typedef {{pcb: PCBApp|null, schematic: SchematicApp|null}} McpEditors */

/** @param {number} value */
const round = value => Math.round(value * 1000) / 1000;

/**
 * Bring the PCB editor up to date with the project, even while the schematic is shown.
 * @param {PCBApp|null} pcb
 */
function currentPcb(pcb) {
    if (!pcb) throw new Error('The PCB editor is not available yet.');
    pcb.initialize();
    pcb.ensureViewport();
    if (isEditorStale(pcb)) {
        // An active PCB has a schematic sync pending on a short timer; run it now.
        if (isEditorActive(pcb)) syncFromSchematic(pcb);
        else pcb.preload();
    }
    if (isEditorStale(pcb)) throw new Error('The PCB is not yet synchronised with the schematic.');
    return pcb;
}

/**
 * @param {() => McpEditors} editors
 */
export function createMcpDesignTools(editors) {
    return {
        /** @param {{limit?: number}} [options] */
        async runDrc(options = {}) {
            return pcbDesignRuleReport(currentPcb(editors().pcb), options);
        },
        /** @param {{view: 'schematic'|'pcb', maxSize?: number}} options */
        async render({ view, maxSize = 1600 }) {
            if (view === 'pcb') return renderPcbPng(currentPcb(editors().pcb), { maxSize });
            if (view !== 'schematic') throw new Error('render view must be "schematic" or "pcb".');
            const schematic = editors().schematic;
            if (!schematic?.viewport) throw new Error('The schematic editor is not available yet.');
            const clone = cloneSchematicContentForRender(schematic);
            if (!clone) throw new Error('The schematic is empty.');
            const image = await rasterizeSvgToPng(clone.svgNode, maxSize);
            const { x, y, width, height } = clone.bounds;
            return {
                ...image,
                view: 'schematic',
                units: 'schematic',
                bounds: { x: round(x), y: round(y), width: round(width), height: round(height) },
            };
        },
    };
}
