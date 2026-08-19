/** Headless regression tests for shared PCB selection interaction state. */

globalThis.window = { addEventListener() {} };
globalThis.requestAnimationFrame = (callback) => callback();
const { SelectionManager } = await import('./src/core/SelectionManager.js');

const {
    finishSelectionInteraction,
    placeFloatingSelectionInteraction,
    updateSelectionInteraction,
} = await import('./src/pcb/modules/selection-interaction.js');
const { deleteBoxSelection } = await import('./src/pcb/modules/box-select.js');
const { setPcbSelection } = await import('./src/pcb/modules/selection-registry.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

{
    const text = {
        id: 'text-delete', content: 'X', x: 0, y: 0, size: 1,
        rotation: 0, layer: 'top-silk', strokeWidth: 0.15,
    };
    const calls = [];
    const app = {
        placements: new Map(), tracks: [], vias: [], boardShapes: [], texts: new Map([[text.id, text]]),
        viewport: { scale: 1 },
        history: { execute(command) { command.execute(); } },
        _removeTextElement() {},
        _refreshFills() {},
        _syncClipboardButtons() {},
        _clearProperties() { calls.push('clear'); },
        _setActiveRibbonTab(tab) { calls.push(`tab:${tab}`); },
    };
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    const deleted = deleteBoxSelection(app);
    expect('deleting selected PCB objects closes Properties',
        deleted && !app.texts.has(text.id) && calls.join('|') === 'clear|tab:pcb-home');
}

{
    const observedSelectionStates = [];
    const manager = new SelectionManager();
    const shape = {
        id: 'shape:clear-order',
        selected: false,
        getBounds() { return { minX: 0, minY: 0, maxX: 1, maxY: 1 }; },
        hitTest() { return false; },
        invalidate() { observedSelectionStates.push(manager.isSelected(this.id)); },
    };
    manager.setShapes([shape]);
    manager.select(shape.id);
    observedSelectionStates.length = 0;
    manager.clearSelection();
    expect('deselected objects invalidate after registry selection clears',
        observedSelectionStates.length === 1 && observedSelectionStates[0] === false);
}

{
    const endCalls = [];
    let updates = 0;
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'anchor',
            startWorld: { x: 0, y: 0 },
            moved: false,
            adapter: {
                updateAnchorDrag() { updates++; },
                endAnchorDrag(_commit, options) {
                    endCalls.push(options);
                    return options.place ? undefined : { floating: true };
                },
            },
        },
    };

    expect('anchor update is consumed', updateSelectionInteraction(app, { x: 4, y: 0 }));
    expect('anchor movement crosses the shared threshold', app._pcbSelectionInteraction.moved);
    expect('adapter receives floating update', updates === 1);
    expect('click-release is consumed', finishSelectionInteraction(app, true));
    expect('adapter can retain a floating interaction', app._pcbSelectionInteraction?.mode === 'floating-anchor');
    expect('placement click is consumed', placeFloatingSelectionInteraction(app));
    expect('placement clears the shared interaction', app._pcbSelectionInteraction === null);
    expect('placement reaches the adapter', endCalls[1]?.place === true);
}

{
    const endCalls = [];
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'floating-anchor',
            adapter: { endAnchorDrag(commit) { endCalls.push(commit); } },
        },
    };

    finishSelectionInteraction(app, false);
    expect('Escape cancels a floating interaction', endCalls[0] === false && app._pcbSelectionInteraction === null);
}

{
    const floatingShapeAdapter = {
        endAnchorDrag(commit, options) {
            return commit && !options.moved && !options.place ? { floating: true } : undefined;
        },
    };
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'anchor',
            startWorld: { x: 0, y: 0 },
            moved: false,
            adapter: floatingShapeAdapter,
        },
    };

    finishSelectionInteraction(app, true);
    expect('an untouched generic shape anchor becomes floating', app._pcbSelectionInteraction?.mode === 'floating-anchor');
}

{
    let committed = false;
    const fillAdapter = {
        endAnchorDrag(commit, options) {
            if (commit && !options.moved && !options.place) return { floating: true };
            committed = commit;
        },
    };
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'anchor',
            startWorld: { x: 0, y: 0 },
            moved: true,
            adapter: fillAdapter,
        },
    };

    finishSelectionInteraction(app, true);
    expect('a dragged fill anchor commits on mouse-up', committed && app._pcbSelectionInteraction === null);
}

if (failures) process.exitCode = 1;