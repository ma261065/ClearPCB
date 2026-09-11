import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    createElementNS() { return { setAttribute() {}, appendChild() {} }; },
};

const { deleteBoxSelection } = await import('../src/pcb/modules/box-select.js');
const { setPcbSelection, getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');

const kinds = ['line', 'rect', 'polygon', 'circle', 'arc'];
for (const layer of ['hole', 'top-copper', 'top-silk']) {
    for (const selectionKinds of [...kinds.map((kind) => [kind]), kinds]) {
        const shapes = selectionKinds.map((kind, index) => ({
            id: `shape-${index}`, kind, layer, lineWidth: 1,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
            x: 5, y: 5, radius: 5,
            start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 5 },
        }));
        let properties = 'Shape Properties';
        let clearCount = 0;
        let activeTab = 'pcb-properties';
        let tabChanges = 0;
        const app = {
            boardShapes: [...shapes], placements: new Map(), tracks: [], vias: [], texts: new Map(),
            _shapeElements: new Map(), _getLayerGroup() { return null; },
            history: { execute(command) { command.execute(); } },
            _clearProperties() {
                assert.equal(this.boardShapes.length, 0);
                assert.deepEqual(getPcbSelection(this), []);
                properties = 'Properties';
                clearCount++;
            },
            _setActiveRibbonTab(tab) {
                assert.equal(properties, 'Properties');
                activeTab = tab;
                tabChanges++;
            },
        };
        setPcbSelection(app, shapes.map((object) => ({ kind: 'shape', object })));
        assert.equal(deleteBoxSelection(app), true);
        assert.equal(properties, 'Properties');
        assert.equal(clearCount, 1);
        assert.equal(activeTab, 'pcb-home');
        assert.equal(tabChanges, 1);
        activeTab = 'pcb-design';
        assert.equal(deleteBoxSelection(app), false);
        assert.equal(clearCount, 1);
        assert.equal(activeTab, 'pcb-design');
        assert.equal(tabChanges, 1);
    }
}

console.log('PASS: all board-shape deletions clear Properties and return Home, including mixed selections; empty selection is a no-op');