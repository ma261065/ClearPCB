import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './helpers/fake-dom.mjs';

// Ribbons are logic only: editor modules describe tabs, panels, groups and
// items, while shared/ui/ribbon.js is the only code that builds those controls.

const root = fileURLToPath(new URL('../', import.meta.url));
const srcRoot = join(root, 'src');
const readSrc = path => readFileSync(join(srcRoot, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const DESCRIPTIONS = [
    'pcb/modules/ribbon-description.js',
    'schematic/modules/ribbon-description.js',
];
const DOM = /\b(innerHTML|outerHTML|insertAdjacentHTML|querySelector(All)?|getElementById|createElement(NS)?|addEventListener|activeElement)\b|\bdocument\./;
for (const path of DESCRIPTIONS) {
    const match = DOM.exec(readSrc(path));
    assert.equal(match, null, `${path} describes its ribbon; shared/ui/ribbon.js owns the DOM (found ${match?.[0]})`);
}

const index = readFileSync(join(root, 'index.html'), 'utf8');
assert.match(index, /<div class="ribbon" id="ribbonSchematic"><\/div>/);
assert.match(index, /<div class="ribbon ribbon-hidden" id="ribbonPCB"><\/div>/);
assert.equal(/ribbon-tab|ribbon-panel|ribbon-group|ribbonNew|pcbToolSelect|pcbPropertiesPanel/.exec(index), null,
    'index.html holds only ribbon hosts; controls come from descriptions rendered by shared/ui/ribbon.js');

const { renderRibbon } = await import('../src/shared/ui/ribbon.js');
const { createSchematicRibbonDescription } = await import('../src/schematic/modules/ribbon-description.js');
const { createPcbRibbonDescription } = await import('../src/pcb/modules/ribbon-description.js');

const document = installFakeDom();
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 1);
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const viewport = {
    gridVisible: true, snapToGrid: true, gridSize: 1.27, units: 'mm', gridStyle: 'lines',
    getGridOptions: () => [{ value: 1.27, label: '1.27 mm' }],
    setGridSize(value) { this.gridSize = value; },
    setUnits(value) { this.units = value; },
    setGridStyle(value) { this.gridStyle = value; },
    setGridVisible(value) { this.gridVisible = value; },
    setPaperSize(value, key) { this.paperSize = value; this.paperSizeKey = key; },
    setTitleBlock(value) { this.showTitleBlock = value; },
    setTitleBlockInfo(value) { this.showTitleBlockInfo = value; },
};
const history = { canUndo: () => false, canRedo: () => false };
const schematicApp = {
    viewport, history, currentTool: 'select', toolOptions: {}, fileManager: {}, selection: { getSelection: () => [] },
    selectTool(tool) { this.currentTool = tool; }, setActiveRibbonTab() {}, updatePropertiesPanel() {},
};
const pcbApp = {
    viewport, history, currentTool: 'select', activeLayer: 'top-copper', designSettings: {
        values: { trackWidth: 0.2, clearance: 0.1, viaDiameter: 0.3, viaDrill: 0.15, units: 'mm', router: 'maze' },
        hasAppliedSettings: true,
        update(values) { Object.assign(this.values, values); return true; },
    },
    _canCopyCutPcbSelection: () => false, _hasPcbClipboardData: () => false,
};
const schematicHost = document.createElement('div');
schematicHost.id = 'ribbonSchematic';
document.body.appendChild(schematicHost);
renderRibbon(schematicHost, createSchematicRibbonDescription(schematicApp));
assert.ok(document.getElementById('ribbonNew'));
assert.ok(document.getElementById('ribbonShapeOptions'));
assert.ok(document.getElementById('propertiesPanel'));

const pcbHost = document.createElement('div');
pcbHost.id = 'ribbonPCB';
document.body.appendChild(pcbHost);
renderRibbon(pcbHost, createPcbRibbonDescription(pcbApp));
assert.ok(document.getElementById('pcbToolSelect'));
assert.ok(document.getElementById('pcbLayerPanel'));
assert.ok(document.getElementById('pcbPropertiesPanel'));
assert.ok(document.getElementById('pcbPropsItems'));

const LOOKUP_SOURCES = [
    'pcb/modules/controls.js',
    'schematic/modules/ribbon.js',
    'pcb/modules/design-settings.js',
    'schematic/modules/theme.js',
    'schematic/modules/paper.js',
    'schematic/modules/files.js',
    'ui/PCBApp.js',
    'ui/SchematicApp.js',
];
const allowedLookups = new Set([
    "pcb/modules/controls.js: const ribbonEl = document.getElementById('ribbonPCB');",
    "schematic/modules/ribbon.js: const ribbonEl = document.getElementById('ribbonSchematic');",
    "schematic/modules/ribbon.js: const anchor = document.getElementById('docTitle');",
    "schematic/modules/ribbon.js: const existing = document.getElementById('ribbon-save-toast');",
    "schematic/modules/ribbon.js: const container = document.getElementById('ribbonShapeOptions');",
    "ui/PCBApp.js: this.ribbon = document.getElementById('ribbonPCB');",
    "ui/PCBApp.js: gridSnap: document.getElementById('pcbGridSnap'),",
    "ui/PCBApp.js: const anchor = this.status.docTitle || document.getElementById('pcbDocTitle');",
    "ui/PCBApp.js: const existing = document.getElementById('ribbon-save-toast');",
    "ui/PCBApp.js: const el = document.querySelector('#pcbPropsContent .ribbon-group-title');",
    "ui/PCBApp.js: const host = document.getElementById('pcbPropertiesPanel');",
    "ui/PCBApp.js: return document.getElementById('pcbPropsItems');",
    "ui/PCBApp.js: const items = document.getElementById('pcbPropsItems');",
    "ui/PCBApp.js: const host = document.getElementById('pcbPropertiesPanel');",
    "ui/SchematicApp.js: document.querySelector('.ribbon')?.addEventListener('contextmenu', (e) => {",
]);
const RIBBON_LOOKUP = /\bdocument\.(?:getElementById|querySelector|querySelectorAll)\([^)]*(?:ribbon|Ribbon|pcbTool|pcbUndo|pcbRedo|pcbCopy|pcbCut|pcbPaste|pcbGrid|pcbUnits|pcbRoute|pcbRouter|pcbTrack|pcbClearance|pcbVia|pcbDrc|pcbLayer|pcbProps|pcbProperties|propertiesPanel|themeToggle|undoBtn|redoBtn|gridSize|gridStyle|showGrid|snapToGrid|paperSize|paperOrientation|showTitleBlock)/;
const lookupOffenders = [];
for (const path of LOOKUP_SOURCES) {
    for (const line of readSrc(path).split(/\r?\n/)) {
        const text = line.trim();
        if (RIBBON_LOOKUP.test(text) && !allowedLookups.has(`${path}: ${text}`)) lookupOffenders.push(`${path}: ${text}`);
    }
}
assert.deepEqual(lookupOffenders, [], 'Ribbon control behavior/state uses description handlers and renderer refresh; only host/slot lookups are allowed');

console.log(`PASS Ribbons are logic only (${DESCRIPTIONS.length} descriptions; controls built by shared/ui/ribbon.js)`);
