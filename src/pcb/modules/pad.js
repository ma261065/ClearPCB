import { padLayers, padOutline } from '../../shapes/pad-geometry.js';
export { padLayers, padOutline, padBounds, padHitTest, padFlash } from '../../shapes/pad-geometry.js';
import { textColorForLayer } from './pcb-text.js';
import { renderDrillBore } from './drill-bore.js';

const NS = 'http://www.w3.org/2000/svg';

/** @type {WeakMap<object, SVGElement[]>} */
const padElements = new WeakMap();

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
    for (const element of padElements.get(pad) || []) element.remove();
    padElements.delete(pad);
}

export function padCopperPathD(pad) {
    const points = padOutline(pad);
    if (!points.length) return '';
    let path = `M${points.map(point => `${point.x},${point.y}`).join('L')}Z`;
    if (pad.drill > 0) {
        const radius = pad.drill / 2;
        path += `M${pad.x + radius},${pad.y}`
            + `A${radius},${radius} 0 1 0 ${pad.x - radius},${pad.y}`
            + `A${radius},${radius} 0 1 0 ${pad.x + radius},${pad.y}Z`;
    }
    return path;
}

export function renderPad(pad, getLayerGroup, strokeOverride = null) {
    removePadElements(pad);
    if (pad.visible === false) return;
    const elements = [];
    for (const layer of padLayers(pad)) {
        const group = getLayerGroup(layer);
        if (!group) continue;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', padCopperPathD(pad));
        path.setAttribute('fill-rule', 'evenodd');
        path.setAttribute('fill', strokeOverride || textColorForLayer(layer));
        path.setAttribute('fill-opacity', '1');
        path.dataset.padId = pad.id;
        if (pad.net) path.dataset.net = pad.net;
        group.appendChild(path);
        elements.push(path);
        const drill = renderDrillBore(pad, getLayerGroup(`${layer}-pad-drills`), 'pcb-pad-drill', 'pad');
        if (drill) elements.push(drill);
    }
    padElements.set(pad, elements);
}
