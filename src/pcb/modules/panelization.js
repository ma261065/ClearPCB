import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { boardBoundary, getBoardOutline, validBoardOutline } from './board-outline.js';

export const PANEL_DEFAULTS = Object.freeze({
    rows: 2, columns: 2, rowSpacing: 2, columnSpacing: 2,
    separation: 'tabs', railTop: 5, railBottom: 5, railLeft: 0, railRight: 0,
    tabWidth: 3, holeDiameter: 0.5, holePitch: 0.8,
    verticalTabsPerEdge: 2, horizontalTabsPerEdge: 2, verticalTabOffset: 0, horizontalTabOffset: 0,
    horizontalPositioningHoles: false, horizontalFiducials: false,
    verticalPositioningHoles: false, verticalFiducials: false,
});

export function panelSettings(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid panel settings.');
    const settings = { ...PANEL_DEFAULTS };
    for (const key of Object.keys(settings)) {
        if (value[key] !== undefined) settings[key] = value[key];
    }
    for (const key of ['verticalTabOffset', 'horizontalTabOffset']) {
        if (value[key] === undefined && value.tabOffset !== undefined) settings[key] = value.tabOffset;
    }
    for (const key of ['verticalTabsPerEdge', 'horizontalTabsPerEdge']) {
        if (value[key] === undefined && value.tabsPerEdge !== undefined) settings[key] = value.tabsPerEdge;
    }
    for (const key of ['rows', 'columns']) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) {
            throw new Error('Rows and columns must be whole numbers from 1 to 20.');
        }
    }
    if (settings.rows * settings.columns > 100) throw new Error('A panel can contain at most 100 boards.');
    for (const key of ['verticalTabsPerEdge', 'horizontalTabsPerEdge']) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) {
            throw new Error('Tabs per edge must be a whole number from 1 to 20.');
        }
    }
    for (const key of ['verticalTabOffset', 'horizontalTabOffset']) {
        if (!Number.isFinite(settings[key]) || Math.abs(settings[key]) > 100) {
            throw new Error('Tab offsets must be between -100 and 100 mm.');
        }
    }
    for (const key of ['rowSpacing', 'columnSpacing', 'railTop', 'railBottom', 'railLeft', 'railRight']) {
        if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100) {
            throw new Error('Spacing and rail widths must be between 0 and 100 mm.');
        }
    }
    if (!['tabs', 'vcut'].includes(settings.separation)) throw new Error('Unknown panel separation method.');
    for (const key of ['horizontalPositioningHoles', 'horizontalFiducials', 'verticalPositioningHoles', 'verticalFiducials']) {
        if (typeof settings[key] !== 'boolean') throw new Error('Rail feature options must be boolean values.');
    }
    for (const key of ['tabWidth', 'holeDiameter', 'holePitch']) {
        if (!Number.isFinite(settings[key]) || settings[key] <= 0 || settings[key] > 20) {
            throw new Error('Tab and drill dimensions must be greater than zero and at most 20 mm.');
        }
    }
    if (settings.holePitch <= settings.holeDiameter) throw new Error('Hole pitch must exceed hole diameter.');
    if (settings.tabWidth < settings.holePitch * 2) throw new Error('Tabs must be at least two hole pitches wide.');
    return value.noteCreated === true ? { ...settings, noteCreated: true } : settings;
}

const PRECISION = 100000;
const rectangle = (x, y, width, height) => [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const translate = (points, dx, dy) => points.map(point => ({ x: point.x + dx, y: point.y + dy }));

function mergeSubstrate(contours) {
    const clipper = new ClipperLib.Clipper();
    for (const contour of contours) {
        const path = contour.map(point => ({ X: Math.round(point.x * PRECISION), Y: Math.round(point.y * PRECISION) }));
        if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
        clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true);
    }
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(ClipperLib.ClipType.ctUnion, tree,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    if (tree.Childs().length !== 1) throw new Error('Panel contains disconnected boards or rails. Adjust spacing or tabs.');
    return ClipperLib.Clipper.PolyTreeToPaths(tree)
        .map(path => path.map(point => ({ x: point.X / PRECISION, y: point.Y / PRECISION })));
}

function boundaryCrossing(points, axis, offset, high) {
    const along = axis === 'x' ? 'y' : 'x';
    const crossings = [];
    for (let index = 0; index < points.length; index++) {
        const start = points[index], end = points[(index + 1) % points.length];
        if ((start[along] <= offset && end[along] > offset) || (end[along] <= offset && start[along] > offset)) {
            crossings.push(start[axis] + (end[axis] - start[axis]) * (offset - start[along]) / (end[along] - start[along]));
        }
    }
    if (!crossings.length) throw new Error('Cannot place a tab on this outline. Adjust tab width or board outline.');
    return high ? Math.max(...crossings) : Math.min(...crossings);
}

export function buildPanelLayout(app, input = app.panelization) {
    const settings = panelSettings(input);
    if (!validBoardOutline(getBoardOutline(app))) throw new Error('Panelization requires a valid closed board outline.');
    const bounds = boardBoundary(app);
    const { rows, columns, separation } = settings;
    if (separation === 'vcut') {
        const area = Math.abs(bounds.points.reduce((sum, point, index) => {
            const next = bounds.points[(index + 1) % bounds.points.length];
            return sum + point.x * next.y - next.x * point.y;
        }, 0)) / 2;
        if (Math.abs(area - bounds.w * bounds.h) > 1e-5) {
            throw new Error('V-cuts require an axis-aligned rectangular board with square corners. Use routed tabs for other outlines.');
        }
    } else if ((rows > 1 && settings.rowSpacing < 1) || (columns > 1 && settings.columnSpacing < 1)) {
        throw new Error('Routed board spacing must be at least 1 mm. Confirm the cutter size with your manufacturer.');
    }
    const pitchX = bounds.w + settings.columnSpacing;
    const pitchY = bounds.h + settings.rowSpacing;
    const width = bounds.w * columns + settings.columnSpacing * (columns - 1);
    const height = bounds.h * rows + settings.rowSpacing * (rows - 1);
    const gapX = separation === 'tabs' ? Math.max(1, settings.columnSpacing) : 0;
    const gapY = separation === 'tabs' ? Math.max(1, settings.rowSpacing) : 0;
    const left = settings.railLeft ? settings.railLeft + gapX : 0;
    const right = settings.railRight ? settings.railRight + gapX : 0;
    const top = settings.railTop ? settings.railTop + gapY : 0;
    const bottom = settings.railBottom ? settings.railBottom + gapY : 0;
    const panelBounds = {
        x: bounds.x - left, y: bounds.y - top,
        w: width + left + right,
        h: height + top + bottom,
    };
    if (panelBounds.w > 1000 || panelBounds.h > 1000) throw new Error('Panel dimensions must not exceed 1000 mm.');
    const instances = [];
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            instances.push({ row, column, dx: column * pitchX, dy: row * pitchY,
                points: translate(bounds.points, column * pitchX, row * pitchY) });
        }
    }
    const rails = [];
    if (settings.railTop) rails.push(rectangle(panelBounds.x, panelBounds.y, panelBounds.w, settings.railTop));
    if (settings.railBottom) rails.push(rectangle(panelBounds.x, bounds.y + height + gapY, panelBounds.w, settings.railBottom));
    if (settings.railLeft) rails.push(rectangle(panelBounds.x, panelBounds.y, settings.railLeft, panelBounds.h));
    if (settings.railRight) rails.push(rectangle(bounds.x + width + gapX, panelBounds.y, settings.railRight, panelBounds.h));
    const cuts = [], drills = [], tabs = [];
    let contours;
    if (separation === 'vcut') {
        const cutX = new Set(), cutY = new Set();
        for (let column = 0; column < columns; column++) {
            if (column || settings.railLeft) cutX.add(bounds.x + column * pitchX);
            if (column < columns - 1 || settings.railRight) cutX.add(bounds.x + column * pitchX + bounds.w);
        }
        for (let row = 0; row < rows; row++) {
            if (row || settings.railTop) cutY.add(bounds.y + row * pitchY);
            if (row < rows - 1 || settings.railBottom) cutY.add(bounds.y + row * pitchY + bounds.h);
        }
        for (const x of cutX) cuts.push([{ x, y: panelBounds.y }, { x, y: panelBounds.y + panelBounds.h }]);
        for (const y of cutY) cuts.push([{ x: panelBounds.x, y }, { x: panelBounds.x + panelBounds.w, y }]);
        contours = [rectangle(panelBounds.x, panelBounds.y, panelBounds.w, panelBounds.h)];
    } else {
        const addTabs = (first, second, axis, start, length) => {
            const tabsPerEdge = axis === 'x' ? settings.verticalTabsPerEdge : settings.horizontalTabsPerEdge;
            const spacing = length / tabsPerEdge;
            const half = settings.tabWidth / 2;
            const tabOffset = axis === 'x' ? settings.verticalTabOffset : settings.horizontalTabOffset;
            if (settings.tabWidth >= spacing) {
                throw new Error('Tabs must fit along each connected board edge without touching. Reduce tab width or tabs per edge.');
            }
            if (Math.abs(tabOffset) + half >= spacing / 2) {
                throw new Error('Tab offset places a tab at or beyond a board edge end. Reduce the offset, tab width or tabs per edge.');
            }
            for (let tabIndex = 0; tabIndex < tabsPerEdge; tabIndex++) {
                const center = start + (tabIndex + 0.5) * spacing + tabOffset;
                const offsets = [center - half, center, center + half];
                const firstEnds = offsets.map(offset => boundaryCrossing(first, axis, offset, true));
                const secondEnds = offsets.map(offset => boundaryCrossing(second, axis, offset, false));
                const begin = Math.min(...firstEnds) - 0.01, end = Math.max(...secondEnds) + 0.01;
                tabs.push(axis === 'x' ? rectangle(begin, center - half, end - begin, half * 2)
                    : rectangle(center - half, begin, half * 2, end - begin));
                const count = Math.floor((settings.tabWidth - settings.holeDiameter) / settings.holePitch) + 1;
                for (let index = 0; index < count; index++) {
                    const offset = center + (index - (count - 1) / 2) * settings.holePitch;
                    const firstEdge = boundaryCrossing(first, axis, offset, true);
                    const secondEdge = boundaryCrossing(second, axis, offset, false);
                    if (secondEdge - firstEdge <= settings.holeDiameter * 2) {
                        throw new Error('Mouse-bite drill rows would touch or overlap. Increase spacing or reduce hole diameter.');
                    }
                    for (const coordinate of [firstEdge + settings.holeDiameter / 2, secondEdge - settings.holeDiameter / 2]) {
                        drills.push({ x: axis === 'x' ? coordinate : offset,
                            y: axis === 'x' ? offset : coordinate, diameter: settings.holeDiameter });
                    }
                }
            }
        };
        const topRail = rails.find(points => points[0].y === panelBounds.y && settings.railTop);
        const bottomRail = settings.railBottom ? rectangle(panelBounds.x, bounds.y + height + gapY, panelBounds.w, settings.railBottom) : null;
        const leftRail = settings.railLeft ? rectangle(panelBounds.x, panelBounds.y, settings.railLeft, panelBounds.h) : null;
        const rightRail = settings.railRight ? rectangle(bounds.x + width + gapX, panelBounds.y, settings.railRight, panelBounds.h) : null;
        for (const instance of instances) {
            const { row, column, dx, dy, points } = instance;
            if (column < columns - 1) addTabs(points, instances[row * columns + column + 1].points, 'x', bounds.y + dy, bounds.h);
            if (row < rows - 1) addTabs(points, instances[(row + 1) * columns + column].points, 'y', bounds.x + dx, bounds.w);
            if (!row && topRail) addTabs(topRail, points, 'y', bounds.x + dx, bounds.w);
            if (row === rows - 1 && bottomRail) addTabs(points, bottomRail, 'y', bounds.x + dx, bounds.w);
            if (!column && leftRail) addTabs(leftRail, points, 'x', bounds.y + dy, bounds.h);
            if (column === columns - 1 && rightRail) addTabs(points, rightRail, 'x', bounds.y + dy, bounds.h);
        }
        contours = mergeSubstrate([...instances.map(instance => instance.points), ...rails, ...tabs]);
    }
    const positioningHoles = [], fiducials = [];
    const addRailFeatures = (horizontal, thickness, across) => {
        const holes = horizontal ? settings.horizontalPositioningHoles : settings.verticalPositioningHoles;
        const marks = horizontal ? settings.horizontalFiducials : settings.verticalFiducials;
        if (!thickness || (!holes && !marks)) return;
        const start = horizontal ? bounds.x : bounds.y;
        const length = horizontal ? width : height;
        if (thickness < 5) throw new Error('Rails with positioning holes or fiducials must be at least 5 mm wide.');
        const addPair = (inset, target, dimensions) => {
            if (length - inset * 2 < 4) throw new Error('Rail is too short for the selected positioning holes and fiducials.');
            for (const along of [start + inset, start + length - inset]) {
                target.push({ x: horizontal ? along : across, y: horizontal ? across : along, ...dimensions });
            }
        };
        if (holes) addPair(2.5, positioningHoles, { diameter: 3 });
        if (marks) addPair(holes ? 6.5 : 2.5, fiducials, { diameter: 1, maskDiameter: 3 });
    };
    if ((settings.horizontalPositioningHoles || settings.horizontalFiducials) && !settings.railTop && !settings.railBottom) {
        throw new Error('Horizontal rail features require a top or bottom rail.');
    }
    if ((settings.verticalPositioningHoles || settings.verticalFiducials) && !settings.railLeft && !settings.railRight) {
        throw new Error('Vertical rail features require a left or right rail.');
    }
    addRailFeatures(true, settings.railTop, panelBounds.y + settings.railTop / 2);
    addRailFeatures(true, settings.railBottom, bounds.y + height + gapY + settings.railBottom / 2);
    addRailFeatures(false, settings.railLeft, panelBounds.x + settings.railLeft / 2);
    addRailFeatures(false, settings.railRight, bounds.x + width + gapX + settings.railRight / 2);
    const railFeatures = [...positioningHoles, ...fiducials].map(feature => ({
        ...feature, radius: ('maskDiameter' in feature ? feature.maskDiameter : feature.diameter) / 2,
    }));
    for (let index = 0; index < railFeatures.length; index++) {
        const feature = railFeatures[index];
        for (const other of [...railFeatures.slice(index + 1), ...drills.map(drill => ({ ...drill, radius: drill.diameter / 2 }))]) {
            if (Math.hypot(feature.x - other.x, feature.y - other.y) < feature.radius + other.radius + 1 - 1e-9) {
                throw new Error('Rail features need 1 mm clearance from other features and mouse-bite holes. Adjust rails or tabs.');
            }
        }
        for (const [start, end] of cuts) {
            const distance = start.x === end.x ? Math.abs(feature.x - start.x) : Math.abs(feature.y - start.y);
            if (distance < feature.radius + 1 - 1e-9) throw new Error('Rail features need 1 mm clearance from V-score lines.');
        }
    }
    drills.push(...positioningHoles);
    const note = [
        `Panel: ${rows} rows x ${columns} columns (${rows * columns} boards)`,
        `Row spacing: ${settings.rowSpacing} mm; column spacing: ${settings.columnSpacing} mm`,
        `Rails T/B/L/R: ${settings.railTop}/${settings.railBottom}/${settings.railLeft}/${settings.railRight} mm`,
        separation === 'vcut' ? 'Separation: V-score (see board-vscore.gbr)'
            : `Separation: routed tabs/edge V/H ${settings.verticalTabsPerEdge}/${settings.horizontalTabsPerEdge}, offset V/H ${settings.verticalTabOffset}/${settings.horizontalTabOffset} mm, width ${settings.tabWidth} mm; NPTH ${settings.holeDiameter} mm / pitch ${settings.holePitch} mm`,
    ];
    return { settings, bounds: panelBounds, sourceBounds: bounds, instances, rails, tabs, contours, cuts, drills, positioningHoles, fiducials, note };
}