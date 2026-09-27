import { padFlashOutline } from './board-geometry.js';
import { textColorForLayer } from './pcb-text.js';
import { VIA_DRILL_COLOR } from './pcb-colors.js';

const NS = 'http://www.w3.org/2000/svg';

function flashShape(pad) {
    if (pad.shape === 'round') return 'circle';
    if (pad.shape === 'oval') return 'ellipse';
    if (pad.shape === 'stadium') return 'oval';
    return 'rect';
}

export function padLayers(pad) {
    if (pad.layers === 'both') return ['top-copper', 'bottom-copper'];
    return [pad.layers];
}

export function padOutline(pad) {
    const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
    const width = Number.isFinite(pad.width) ? pad.width : pad.size * ratio;
    const height = Number.isFinite(pad.height) ? pad.height : pad.size;
    return padFlashOutline({
        x: pad.x,
        y: pad.y,
        w: width,
        h: height,
        shape: flashShape(pad),
        rad: -(pad.rotation || 0) * Math.PI / 180,
    });
}

export function padBounds(pad) {
    const points = padOutline(pad);
    const radius = pad.drill / 2;
    return {
        minX: Math.min(pad.x - radius, ...points.map(point => point.x)),
        minY: Math.min(pad.y - radius, ...points.map(point => point.y)),
        maxX: Math.max(pad.x + radius, ...points.map(point => point.x)),
        maxY: Math.max(pad.y + radius, ...points.map(point => point.y)),
    };
}

export function padHitTest(pad, point) {
    const angle = (pad.rotation || 0) * Math.PI / 180;
    const dx = point.x - pad.x;
    const dy = point.y - pad.y;
    const x = dx * Math.cos(angle) - dy * Math.sin(angle);
    const y = dx * Math.sin(angle) + dy * Math.cos(angle);
    const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
    const halfWidth = (Number.isFinite(pad.width) ? pad.width : pad.size * ratio) / 2;
    const halfHeight = (Number.isFinite(pad.height) ? pad.height : pad.size) / 2;
    if (pad.shape === 'round' || pad.shape === 'oval') {
        return (x / halfWidth) ** 2 + (y / halfHeight) ** 2 <= 1;
    }
    if (pad.shape === 'stadium') {
        const radius = halfHeight;
        const straight = Math.max(0, halfWidth - radius);
        const nearestX = Math.max(-straight, Math.min(straight, x));
        return Math.hypot(x - nearestX, y) <= radius;
    }
    return Math.abs(x) <= halfWidth && Math.abs(y) <= halfHeight;
}

export function updatePadHighlightGeometry(pad, root) {
    if (!root?.querySelectorAll) return;
    const points = padOutline({ ...pad, x: 0, y: 0 })
        .map(point => `${point.x},${point.y}`).join(' ');
    for (const element of root.querySelectorAll('[data-pad-id]')) {
        if (element.dataset.padId !== pad.id
            || (!element.classList.contains('pcb-track-hover')
                && !element.classList.contains('pcb-box-pad-sel'))) continue;
        element.setAttribute('points', points);
        element.setAttribute('transform', `translate(${pad.x},${pad.y})`);
    }
}

export function removePadElements(pad) {
    for (const element of pad._svgElements || []) element.remove();
    pad._svgElements = null;
}

export function renderPad(pad, getLayerGroup, strokeOverride = null) {
    removePadElements(pad);
    if (pad.visible === false) return;
    const points = padOutline({ ...pad, x: 0, y: 0 });
    const elements = [];
    for (const layer of padLayers(pad)) {
        const group = getLayerGroup(layer);
        if (!group) continue;
        const polygon = document.createElementNS(NS, 'polygon');
        polygon.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
        polygon.setAttribute('transform', `translate(${pad.x},${pad.y})`);
        polygon.setAttribute('fill', strokeOverride || textColorForLayer(layer));
        polygon.setAttribute('fill-opacity', '0.9');
        polygon.dataset.padId = pad.id;
        if (pad.net) polygon.dataset.net = pad.net;
        group.appendChild(polygon);
        elements.push(polygon);
    }
    const holeLayer = getLayerGroup('hole');
    if (holeLayer && pad.drill > 0) {
        const drill = document.createElementNS(NS, 'circle');
        drill.setAttribute('cx', String(pad.x));
        drill.setAttribute('cy', String(pad.y));
        drill.setAttribute('r', String(pad.drill / 2));
        drill.setAttribute('fill', VIA_DRILL_COLOR);
        drill.dataset.padId = pad.id;
        if (pad.net) drill.dataset.net = pad.net;
        holeLayer.appendChild(drill);
        elements.push(drill);
    }
    pad._svgElements = elements;
}

export function padFlash(pad) {
    const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
    return {
        x: pad.x, y: pad.y,
        w: Number.isFinite(pad.width) ? pad.width : pad.size * ratio,
        h: Number.isFinite(pad.height) ? pad.height : pad.size,
        shape: flashShape(pad), rotation: pad.rotation,
        rad: -(pad.rotation || 0) * Math.PI / 180,
    };
}
