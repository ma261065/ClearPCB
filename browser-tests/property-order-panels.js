/**
 * Runs inside the app page: shows the Properties panel for one of each kind of
 * object and tool, and returns each panel's rows as `{ key, label }` (`key` is the
 * row's `data-prop`). Kept separate from the scenario so it can also be imported in a live page.
 * @returns {Promise<Record<string, Array<{key: string|null, label: string}>>>}
 */
export async function collectPropertyPanels() {
    const at = path => import(new URL(path, location.origin).href);
    const [{ Track }, { Via }, { Pad }, { CopperFill }, { createPcbText }, trackCommands, { AddPadCommand }, { AddFillCommand },
        { AddTextCommand }, { AddBoardShapeCommand }, { setPcbSelection }, trackSelect, shapeProps, { createRect, createLine },
        { Circle }, { Arc }, { Text }, { Net }, { Wire }] = await Promise.all([
        at('/src/shapes/track.js'), at('/src/shapes/via.js'), at('/src/shapes/pad.js'), at('/src/shapes/copper-fill.js'),
        at('/src/core/pcb-text.js'), at('/src/pcb/modules/track-commands.js'), at('/src/pcb/modules/pad-commands.js'),
        at('/src/pcb/modules/copper-fill-commands.js'), at('/src/pcb/modules/text-commands.js'), at('/src/pcb/modules/shape-commands.js'),
        at('/src/pcb/modules/selection-registry.js'), at('/src/pcb/modules/track-select.js'), at('/src/pcb/modules/board-shape-properties.js'),
        at('/src/shapes/polyline.js'), at('/src/shapes/circle.js'), at('/src/shapes/arc.js'), at('/src/shapes/text.js'),
        at('/src/shapes/net.js'), at('/src/shapes/wire.js'),
    ]);
    const { pcbApp: pcb, schematicApp: schematic } = /** @type {any} */ (window).bootstrap;
    const panels = {};
    // Every row with a control must be tagged; status rows such as "1 selected" carry no property.
    const read = items => [...items.querySelectorAll('.prop-row')]
        .filter(row => row.dataset.prop || row.querySelector('input, select, textarea, button'))
        .map(row => ({ key: row.dataset.prop || null,
            label: ((row.tagName === 'LABEL' ? row : row.querySelector('label'))?.textContent || '').trim().replace(/\s+/g, ' ') }));
    const pcbPanel = (name, show) => { show(); panels[`pcb ${name}`] = read(pcb._pcbPropsItems()); };
    const add = command => pcb.history.execute(command);
    const select = (kind, object) => setPcbSelection(pcb, [{ kind, object }]);

    const track = new Track({ net: 'N1', width: 0.3, layer: 'top-copper', points: [{ x: 5, y: -5 }, { x: 15, y: -5 }, { x: 15, y: -10 }] });
    const loop = new Track({ width: 0.3, layer: 'top-copper', graphNodes: { n0: { x: 20, y: -5 }, n1: { x: 26, y: -5 }, n2: { x: 26, y: -9 }, n3: { x: 20, y: -9 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n2', to: 'n3' }, e3: { from: 'n3', to: 'n0' } } });
    const via = new Via({ x: 30, y: -5, net: 'N1' });
    const pad = new Pad({ x: 35, y: -5, shape: 'rectangle', size: 1.5, ratio: 2, drill: 0.6, rotation: 0, layers: 'both', net: 'N1' });
    const fill = new CopperFill({ layer: 'top-copper', net: 'GND', outline: [{ x: 40, y: -5 }, { x: 50, y: -5 }, { x: 50, y: -15 }, { x: 40, y: -15 }] });
    const text = createPcbText({ text: 'ABC', x: 5, y: -20, layer: 'top-silk', size: 1.5 });
    for (const command of [new trackCommands.AddTrackCommand(pcb, track), new trackCommands.AddTrackCommand(pcb, loop),
        new trackCommands.AddViaCommand(pcb, via), new AddPadCommand(pcb, pad), new AddFillCommand(pcb, fill), new AddTextCommand(pcb, text)]) add(command);
    const shape = (id, extra) => ({ id, kind: 'polygon', layer: 'top-silk', lineWidth: 0.2, filled: false, copperMode: 'add', plated: false, net: '',
        points: [{ x: 5, y: -30 }, { x: 10, y: -30 }, { x: 5, y: -25 }], ...extra });
    const shapes = {
        'silk polygon': shape('pshape_order_1', {}),
        'filled copper polygon': shape('pshape_order_2', { layer: 'top-copper', filled: true, net: 'N1' }),
        'copper cut-out rectangle': shape('pshape_order_3', { kind: 'rect', layer: 'top-copper', copperMode: 'remove-copper',
            points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }),
        'plated hole circle': { id: 'pshape_order_4', kind: 'circle', layer: 'hole', x: 12, y: -30, radius: 1, lineWidth: 0.2, filled: false, copperMode: 'add', plated: true, net: '' },
        'copper circle': { id: 'pshape_order_5', kind: 'circle', layer: 'top-copper', x: 16, y: -30, radius: 1, lineWidth: 0.3, filled: false, copperMode: 'add', plated: false, net: 'N1' },
        'copper image': { id: 'pshape_order_6', kind: 'image', name: 'Logo', layer: 'top-copper', filled: true, lineWidth: 0.05, copperMode: 'add', net: '',
            artwork: { width: 2, height: 2, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] },
            points: [{ x: 20, y: -32 }, { x: 22, y: -32 }, { x: 22, y: -30 }, { x: 20, y: -30 }] },
    };
    for (const object of Object.values(shapes)) add(new AddBoardShapeCommand(pcb, object));

    pcbPanel('track', () => { select('track', track); trackSelect.showTrackSelectionProperties(pcb, track); });
    pcbPanel('closed track loop', () => { select('track', loop); trackSelect.showTrackSelectionProperties(pcb, loop); });
    pcbPanel('via', () => { select('via', via); trackSelect.showViaProperties(pcb, via); });
    pcbPanel('pad', () => { select('pad', pad); pcb._showPadProperties(pad); });
    pcbPanel('copper pour', () => { select('fill', fill); pcb._showFillProperties(fill); });
    pcbPanel('text', () => { select('text', text); pcb._showTextProperties(text); });
    for (const [name, object] of Object.entries(shapes)) {
        pcbPanel(name, () => { select('shape', object); shapeProps.showBoardShapeProperties(pcb, object); });
    }
    const outline = pcb.boardShapes.find(object => object.layer === 'board-outline');
    if (outline) pcbPanel('board outline', () => { select('shape', outline); shapeProps.showBoardShapeProperties(pcb, outline); });
    pcbPanel('multi-selection', () => {
        const entries = [{ kind: 'track', object: track }, { kind: 'via', object: via }];
        setPcbSelection(pcb, entries);
        pcb._showPcbMultiSelectionProperties(entries);
    });
    pcbPanel('new track', () => pcb._showTrackDrawProperties());
    pcbPanel('new via', () => pcb._showViaToolProperties());
    pcbPanel('new pad', () => pcb._showPadEditor(null));
    pcbPanel('new text', () => pcb._showTextToolProperties());
    for (const layer of ['top-silk', 'top-copper', 'hole']) {
        for (const kind of ['line', 'rect', 'circle']) {
            pcbPanel(`new ${kind} on ${layer}`, () => { pcb.activeLayer = layer; shapeProps.showBoardShapeToolProperties(pcb, kind); });
        }
    }
    setPcbSelection(pcb, []);

    const schematicPanel = (name, selection, tool = 'select') => {
        schematic.currentTool = tool;
        schematic._updatePropertiesPanel(selection);
        panels[`schematic ${name}`] = read(schematic.ui.propertiesPanel);
    };
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    wire.net = 'N1';
    const field = new Text({ x: 0, y: 0, text: 'R1' });
    field.fieldKey = 'reference';
    schematicPanel('rectangle', [createRect({ x: 0, y: 0, width: 10, height: 5, cornerRadius: 1 })]);
    schematicPanel('line', [createLine([{ x: 0, y: 0 }, { x: 10, y: 0 }])]);
    schematicPanel('circle', [new Circle({ x: 0, y: 0, radius: 5 })]);
    schematicPanel('arc', [new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 } })]);
    schematicPanel('label', [new Text({ x: 0, y: 0, text: 'Label' })]);
    schematicPanel('reference field', [field]);
    schematicPanel('net label', [new Net({ x: 0, y: 0, net: 'GND' })]);
    schematicPanel('wire', [wire]);
    for (const tool of ['rect', 'text', 'net', 'wire']) schematicPanel(`new ${tool}`, [], tool);
    schematic.currentTool = 'select';
    schematic._updatePropertiesPanel([]);
    return panels;
}
