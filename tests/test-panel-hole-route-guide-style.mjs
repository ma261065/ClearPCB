import assert from 'node:assert/strict';
import { pointInPolygon } from '../src/core/geometry.js';

function node(localName = 'g') {
    const attributes = new Map();
    return {
        localName, children: [], parentNode: null, dataset: {}, style: {},
        get id() { return attributes.get('id'); },
        setAttribute(key, value) { attributes.set(key, String(value)); },
        getAttribute(key) { return attributes.get(key) ?? null; },
        removeAttribute(key) { attributes.delete(key); },
        classList: {
            add(value) { attributes.set('class', `${attributes.get('class') || ''} ${value}`.trim()); },
            contains(value) { return (attributes.get('class') || '').split(' ').includes(value); },
        },
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; },
        removeChild(child) { child.remove(); return child; },
        insertBefore(child, before) {
            child.remove();
            this.children.splice(this.children.indexOf(before), 0, child);
            child.parentNode = this;
        },
        remove() {
            if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        },
    };
}
const timers = new Map();
let timerId = 0;
globalThis.window = { addEventListener() {} };
globalThis.document = {
    documentElement: node('html'), getElementById() { return null; },
    createElementNS: (_, name) => node(name),
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
const { renderPanelPreview, resetPanelPreview } = await import('../src/pcb/modules/panelization-ui.js');
const { renderBoardShape } = await import('../src/pcb/modules/board-shapes.js');
const { rectangleBoardOutline } = await import('../src/shared/pcb/board-outline.js');
const { startTrackDraw, updateTrackDraw, cancelTrackDraw, reconcileRatsnest, setTrackToolNet } =
    await import('../src/pcb/modules/track-draw.js');
const { Pad } = await import('../src/shapes/pad.js');

const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const reference = (root, url) => descendants(root).find(child => child.id === url.slice(5, -1));
for (const theme of ['light', 'dark']) {
    document.documentElement.setAttribute('data-theme', theme);
    for (const scale of [25, 100, 400]) {
        const root = node('svg');
        root.setAttribute('viewBox', `${-20 / scale} ${-30 / scale} ${100 / scale} ${80 / scale}`);
        const grid = root.appendChild(node('g'));
        grid.setAttribute('id', 'grid');
        const layers = new Map(['board-outline', 'top-copper', 'top-document', 'hole', 'ratlines']
            .map(id => [id, root.appendChild(node())]));
        const app = {
            tracks: [], vias: [], pads: [], placements: new Map(), netlist: [],
            _shapeElements: new Map(),
            boardShapes: [rectangleBoardOutline(30, 20)],
            panelization: { rows: 2, columns: 3, railTop: 6, railBottom: 6, railLeft: 6, railRight: 6,
                horizontalPositioningHoles: true, verticalPositioningHoles: true },
            viewport: { svg: root, scale, gridVisible: false,
                addContent: child => root.appendChild(child), setCrosshair() {}, hideCrosshair() {} },
            _layerGroups: layers, existingLayerGroups: () => layers, getLayerGroup(id) { return layers.get(id); },
        };
        setTrackToolNet(app, 'GND');
        const source = JSON.stringify(app.boardShapes);
        const layout = renderPanelPreview(app);
        const preview = root.children.find(child => child.classList.contains('pcb-panel-preview'));
        assert.ok(preview);
        const supports = preview.children.find(child => child.getAttribute('fill-opacity') === '0.12');
        const clip = reference(root, supports.getAttribute('clip-path'));
        assert.equal(clip.localName, 'clipPath', 'holes use vector cutouts, not background discs');
        assert.equal(clip.getAttribute('clipPathUnits'), 'userSpaceOnUse');
        const cut = clip.children[0];
        assert.equal(cut.getAttribute('clip-rule'), 'evenodd');
        const { x, y, w, h } = layout.bounds;
        assert.ok(cut.getAttribute('d').startsWith(`M${x},${y}h${w}v${h}h${-w}Z `));
        const contours = [...cut.getAttribute('d').matchAll(/M ([^Z]+) Z/g)].map(([, text]) => {
            const numbers = text.match(/-?\d+(?:\.\d+)?/g).map(Number);
            return Array.from({ length: numbers.length / 2 }, (_, index) =>
                ({ x: numbers[index * 2], y: numbers[index * 2 + 1] }));
        });
        assert.equal(contours.length, layout.positioningHoles.length);
        for (const hole of layout.positioningHoles) {
            assert.equal(contours.filter(contour => pointInPolygon(hole, contour)).length, 1,
                'each tooling bore toggles the support clip off so the actual grid remains visible');
            assert.equal(contours.some(contour => pointInPolygon({ x: hole.x + 1.6, y: hole.y }, contour)), false);
            const ordinary = { id: 'ordinary-hole', layer: 'hole', kind: 'circle',
                x: hole.x, y: hole.y, radius: hole.diameter / 2, lineWidth: 0 };
            renderBoardShape(app, ordinary);
            const ordinaryRoot = app._shapeElements.get(ordinary.id);
            const ordinaryElement = ordinaryRoot.children.at(-1);
            const borderRoot = preview.children.find(child => child.localName === 'g'
                && child.children.at(-1)?.getAttribute('d') === ordinaryElement.getAttribute('d'));
            const border = borderRoot?.children.at(-1);
            assert.ok(border, 'tooling bores reuse the same physical hole geometry');
            assert.equal(border.getAttribute('fill'), 'none', `${theme}: no opaque canvas-colour paint`);
            for (const [painted, owner] of [[border, borderRoot], [ordinaryElement, ordinaryRoot]]) {
                const clip = reference(owner, painted.getAttribute('clip-path'));
                assert.equal(clip.getAttribute('clipPathUnits'), 'userSpaceOnUse');
                assert.equal(clip.children[0].getAttribute('d'), painted.getAttribute('d'));
                assert.equal(clip.children[0].getAttribute('clip-rule'), 'evenodd');
                assert.equal(Number(painted.getAttribute('stroke-width')) / 2, 0.05);
            }
            for (const key of ['stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap']) {
                assert.equal(border.getAttribute(key), ordinaryElement.getAttribute(key), `matches ordinary hole ${key}`);
            }
        }
        assert.deepEqual(preview.children.filter(child => child.localName === 'use')
            .map(child => child.getAttribute('transform')),
        layout.instances.slice(1).map(instance => `translate(${instance.dx},${instance.dy})`));
        assert.equal(preview.getAttribute('transform'), null, 'panel cutouts remain in panel coordinates');
        assert.equal(grid.getAttribute('clip-path'), null, 'grid is never clipped with board artwork');
        assert.equal(grid.parentNode, root);
        assert.equal(JSON.stringify(app.boardShapes), source, 'preview never mutates the source board');
        assert.equal(renderPanelPreview(app), layout, 'cached layout retains its cutouts');
        resetPanelPreview(app);
        assert.equal(clip.parentNode.parentNode, null, 'panel removal disposes hole clip definitions');
        assert.equal(layers.get('hole').getAttribute('clip-path'), null);
        assert.equal(timers.size, 0, 'removal disposes pending raster work');

        app.pads = [new Pad({ x: 0, y: 0, net: 'GND' }),
            new Pad({ x: 20, y: 0, net: 'GND' }), new Pad({ x: 40, y: 0, net: 'GND' }),
            new Pad({ x: 8, y: 10, net: 'OTHER' })];
        reconcileRatsnest(app);
        const ratline = layers.get('ratlines').children.find(child => child.classList.contains('ratsnest-line'));
        assert.ok(ratline, 'compare against an actually rendered real ratline');
        startTrackDraw(app, { x: 0, y: 0 });
        updateTrackDraw(app, { x: 8, y: 4 });
        const guide = app._netGuideLine;
        assert.ok(guide);
        assert.equal(guide.getAttribute('x1'), '8');
        assert.equal(guide.getAttribute('x2'), '20', 'nearest same-net target unchanged');
        assert.equal(guide.getAttribute('y2'), '0');
        for (const key of ['stroke', 'stroke-width', 'stroke-opacity', 'vector-effect']) {
            assert.equal(guide.getAttribute(key), ratline.getAttribute(key), `${theme}, zoom ${scale}: same ${key}`);
        }
        assert.equal(guide.getAttribute('vector-effect'), 'non-scaling-stroke');
        assert.equal(guide.getAttribute('stroke-dasharray'), '4 3', 'screen-space 4px dashes with 3px gaps');
        assert.equal(guide.getAttribute('stroke-linecap'), 'round', 'guide dashes have rounded ends');
        assert.equal(ratline.getAttribute('stroke-dasharray'), null, 'real ratlines remain solid');
        assert.equal(guide.getAttribute('pointer-events'), 'none');
        updateTrackDraw(app, { x: 9, y: 5 });
        assert.equal(guide.parentNode, null, 'moving tip replaces the guide');
        cancelTrackDraw(app);
        assert.equal(app._netGuideLine, null, 'cancellation removes the guide');
    }
}
console.log('PASS panel tooling-hole cutouts and dashed live guides: both themes, 3 zooms, transforms, cleanup');
