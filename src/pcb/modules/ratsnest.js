/**
 * Ratsnest renderer – draws unrouted connection lines between pads
 * that share the same electrical net.
 *
 * Each net produces a minimum spanning tree of thin dashed lines
 * from every pad to at least one other pad on the same net.
 * This gives the user a visual guide of which pads need to be
 * connected by copper traces.
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {Object} PadPosition
 * @property {string} componentId
 * @property {string} pinNumber
 * @property {number} x - World X
 * @property {number} y - World Y
 */

/**
 * Build a ratsnest SVG group from a netlist and placed footprints.
 *
 * @param {Array<{net: string, pins: Array<{componentId: string, pinNumber: string}>}>} netlist
 * @param {Map<string, {x: number, y: number, pads: Map<string, {x: number, y: number}>}>} placements
 *   Map of componentId → { x, y (footprint origin), pads: Map of pinNumber → {x, y} world coords }
 * @returns {SVGGElement} SVG group containing all ratsnest lines
 */
export function buildRatsnest(netlist, placements) {
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'pcb-ratsnest');

    // Color cycle for different nets
    const netColors = [
        '#4fc3f7', '#81c784', '#ffb74d', '#e57373',
        '#ba68c8', '#4dd0e1', '#aed581', '#ffca28',
        '#ff8a65', '#9575cd', '#4db6ac', '#dce775',
    ];

    let colorIdx = 0;
    for (const entry of netlist) {
        const padPositions = [];

        for (const pin of entry.pins) {
            const placement = placements.get(pin.componentId);
            if (!placement) continue;
            const padPos = placement.pads.get(pin.pinNumber);
            if (!padPos) continue;
            padPositions.push({ x: padPos.x, y: padPos.y });
        }

        if (padPositions.length < 2) continue;

        const color = netColors[colorIdx % netColors.length];
        colorIdx++;

        // Build minimum spanning tree (Prim's algorithm)
        const mstEdges = computeMST(padPositions);

        for (const [i, j] of mstEdges) {
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('x1', String(padPositions[i].x));
            line.setAttribute('y1', String(padPositions[i].y));
            line.setAttribute('x2', String(padPositions[j].x));
            line.setAttribute('y2', String(padPositions[j].y));
            line.setAttribute('stroke', '#4488ff');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            line.setAttribute('class', 'ratsnest-line');

            // Store net name as data attribute for future use
            line.dataset.net = entry.net;
            group.appendChild(line);
        }

        // Draw net name at centroid of first MST edge
        if (mstEdges.length > 0) {
            const [a, b] = mstEdges[0];
            const mx = (padPositions[a].x + padPositions[b].x) / 2;
            const my = (padPositions[a].y + padPositions[b].y) / 2;
            const label = document.createElementNS(NS, 'text');
            label.setAttribute('x', String(mx));
            label.setAttribute('y', String(my - 0.6));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('dominant-baseline', 'auto');
            label.setAttribute('font-size', '0.8');
            label.setAttribute('fill', color);
            label.setAttribute('font-family', 'Arial, sans-serif');
            label.setAttribute('opacity', '0.7');
            label.setAttribute('pointer-events', 'none');
            label.textContent = entry.net;
            group.appendChild(label);
        }
    }

    return group;
}

/**
 * Compute a minimum spanning tree using Prim's algorithm.
 * Returns an array of [indexA, indexB] pairs.
 *
 * @param {Array<{x: number, y: number}>} points
 * @returns {Array<[number, number]>}
 */
function computeMST(points) {
    const n = points.length;
    if (n < 2) return [];

    const inTree = new Uint8Array(n);
    const minCost = new Float64Array(n).fill(Infinity);
    const minEdge = new Int32Array(n).fill(-1);
    const edges = /** @type {[number, number][]} */ ([]);

    inTree[0] = 1;
    for (let i = 1; i < n; i++) {
        const dx = points[i].x - points[0].x;
        const dy = points[i].y - points[0].y;
        minCost[i] = dx * dx + dy * dy;
        minEdge[i] = 0;
    }

    for (let iter = 1; iter < n; iter++) {
        let best = -1;
        let bestCost = Infinity;
        for (let i = 0; i < n; i++) {
            if (!inTree[i] && minCost[i] < bestCost) {
                bestCost = minCost[i];
                best = i;
            }
        }
        if (best === -1) break;

        inTree[best] = 1;
        edges.push([minEdge[best], best]);

        for (let i = 0; i < n; i++) {
            if (inTree[i]) continue;
            const dx = points[i].x - points[best].x;
            const dy = points[i].y - points[best].y;
            const cost = dx * dx + dy * dy;
            if (cost < minCost[i]) {
                minCost[i] = cost;
                minEdge[i] = best;
            }
        }
    }

    return edges;
}
