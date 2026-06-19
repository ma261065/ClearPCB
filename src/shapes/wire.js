/**
 * Wire – Graph-based wire for connecting component pins
 *
 * Represents a wire as a graph: nodes connected by edges.
 *   • One Wire object = one electrical net
 *   • Junctions are nodes with degree ≥ 3 (rendered automatically)
 *   • Pin connections map specific nodes to component pins
 *
 * Node IDs: n0, n1, n2, …   Edge IDs: e0, e1, e2, …
 * Anchor IDs: node IDs for vertex handles, mid_eN for edge-midpoint insertion
 */

import { PolylineGraph, COLLINEAR_EPSILON } from './polyline-graph.js';
export { COLLINEAR_EPSILON };

/** Default font size for the wire label text (mm). */
const WIRE_LABEL_FONT_SIZE = 1.4;

/** Default vertical offset of the label above the wire centroid (mm). */
const WIRE_LABEL_DEFAULT_OFFSET_Y = -0.5;

// ── Wire label tracking (Wnnnn) ───────────────────────────────────
const _usedWireLabels = new Set();

/** Allocate the lowest unused wire label (W0001, W0002, …). */
export function nextWireLabel() {
    let i = 1;
    while (_usedWireLabels.has(`W${String(i).padStart(4, '0')}`)) i++;
    const label = `W${String(i).padStart(4, '0')}`;
    _usedWireLabels.add(label);
    return label;
}

/** Register a loaded label so it won't be reused. */
export function bumpWireLabelCounter(label) {
    if (label) _usedWireLabels.add(label);
}

/** Free a label so it can be reused (call when a wire is deleted). */
export function freeWireLabel(label) {
    if (label) _usedWireLabels.delete(label);
}

/** Reset the wire label pool (for testing / new-document). */
export function resetWireLabelCounter() {
    _usedWireLabels.clear();
}

// ── Net name tracking (Net0001, Net0002, …, auto-assigned if not explicitly set) ──
const _usedNetNames = new Set();

function _normalizeAutoNetName(name) {
    if (typeof name !== 'string') return null;
    const m = name.trim().match(/^net(\d+)$/i);
    if (!m) return null;
    return `Net${String(Number(m[1])).padStart(4, '0')}`;
}

/** Allocate the lowest unused net name (Net0001, Net0002, …). */
export function nextNetName() {
    let i = 1;
    while (_usedNetNames.has(`Net${String(i).padStart(4, '0')}`)) i++;
    const name = `Net${String(i).padStart(4, '0')}`;
    _usedNetNames.add(name);
    return name;
}

/** Register a loaded net name so it won't be reused. */
export function bumpNetNameCounter(name) {
    const normalized = _normalizeAutoNetName(name);
    if (normalized) _usedNetNames.add(normalized);
}

/** Free a net name so it can be reused (call when a wire is deleted). */
export function freeNetName(name) {
    const normalized = _normalizeAutoNetName(name);
    if (normalized) _usedNetNames.delete(normalized);
}

/** Reset the net name pool (for testing / new-document). */
export function resetNetNameCounter() {
    _usedNetNames.clear();
}

export class Wire extends PolylineGraph {

    /* ──────────────────────── constructor ──────────────────────── */

    constructor(options = {}) {
        super(options);
        this.type = 'wire';

        // Wire-specific: pin connections
        this.pinConnections = new Map();

        // Net name (auto-assigned if not provided)
        if (options.net) {
            this.net = options.net;
            bumpNetNameCounter(options.net);
        } else {
            this.net = nextNetName();
        }

        // Human-readable wire label (Wnnnn)
        if (options.wireLabel) {
            this.wireLabel = options.wireLabel;
            bumpWireLabelCounter(options.wireLabel);
        } else {
            this.wireLabel = nextWireLabel();
        }

        // Label display offset (relative to wire centroid)
        this.labelOffset = options.labelOffset
            ? { x: options.labelOffset.x || 0, y: options.labelOffset.y || 0 }
            : { x: 0, y: WIRE_LABEL_DEFAULT_OFFSET_Y };

        /** Reference to the linked label Text shape. */
        this.labelText = null;

        // Load pin connections from graph data
        if (options.graphNodes && options.graphEdges && options.pinConnections) {
            for (const [nid, conn] of Object.entries(options.pinConnections))
                this.pinConnections.set(nid, { ...conn });
        }
    }

    /* ──────────────────── Wire-specific graph overrides ───────────── */

    /** @override — also clean up pinConnections when removing a node. */
    removeNode(nodeId) {
        this.pinConnections.delete(nodeId);
        super.removeNode(nodeId);
    }

    /** @override — handle pinConnections during merge. */
    mergeNodes(keepId, removeId) {
        if (keepId === removeId) return;
        if (this.pinConnections.has(removeId) && !this.pinConnections.has(keepId))
            this.pinConnections.set(keepId, this.pinConnections.get(removeId));
        this.pinConnections.delete(removeId);
        super.mergeNodes(keepId, removeId);
    }

    /** @override — protect pin-connected nodes from graph simplification. */
    _isProtectedNode(nodeId) {
        return this.pinConnections.has(nodeId);
    }

    /** @override — handle pinConnections + net names during absorb. */
    _onAbsorb(other, remap) {
        if (other.pinConnections) {
            for (const [oldNid, conn] of other.pinConnections) {
                const newNid = remap.get(oldNid);
                if (newNid && !this.pinConnections.has(newNid))
                    this.pinConnections.set(newNid, { ...conn });
            }
        }
        if (!this.net && other.net) this.net = other.net;
    }

    /** @override — create Wire instances for subgraph extraction. */
    _createSubgraphInstance() {
        return new Wire({ color: this.color, lineWidth: this.lineWidth, net: this.net });
    }

    /** @override — copy pinConnections into extracted subgraph. */
    _onExtractSubgraph(sub, nodeIds) {
        for (const nid of nodeIds) {
            if (this.pinConnections.has(nid))
                sub.pinConnections.set(nid, { ...this.pinConnections.get(nid) });
        }
    }

    /** @override — also delete pinConnection when deleting an anchor. */
    deleteAnchor(anchorId) {
        const result = super.deleteAnchor(anchorId);
        if (result) this.pinConnections.delete(anchorId);
        return result;
    }

    /** @override — also move linked label text. */
    move(dx, dy) {
        super.move(dx, dy);
        if (this.labelText) {
            this.labelText.x += dx;
            this.labelText.y += dy;
            this.labelText.invalidate();
        }
    }

    /** @override */
    clone() {
        const c = new Wire({
            color: this.color, lineWidth: this.lineWidth,
            layer: this.layer, net: this.net,
            visible: this.visible, locked: this.locked,
            labelOffset: { x: this.labelOffset.x, y: this.labelOffset.y },
        });
        for (const [id, p] of this.nodes) c.nodes.set(id, { x: p.x, y: p.y });
        for (const [id, e] of this.edges) c.edges.set(id, { from: e.from, to: e.to });
        for (const [id, cn] of this.pinConnections) c.pinConnections.set(id, { ...cn });
        return c;
    }

    /** @override — includes pinConnections, net, wireLabel, labelOffset. */
    captureState() {
        const s = super.captureState();
        s.pinConnections = {};
        for (const [id, c] of this.pinConnections) s.pinConnections[id] = { ...c };
        s.net = this.net;
        s.wireLabel = this.wireLabel;
        s.labelOffset = { x: this.labelOffset.x, y: this.labelOffset.y };
        return s;
    }

    /** @override — restores pinConnections, net, wireLabel, labelOffset. */
    applyState(state) {
        // Let base restore nodes/edges
        super.applyState(state);
        // Restore wire-specific state
        if (state.pinConnections) {
            this.pinConnections = new Map();
            for (const [id, c] of Object.entries(state.pinConnections)) this.pinConnections.set(id, { ...c });
        }
        if ('net' in state) this.net = state.net || '';
        if (state.wireLabel) {
            freeWireLabel(this.wireLabel);
            this.wireLabel = state.wireLabel;
            bumpWireLabelCounter(state.wireLabel);
            if (this.labelText) {
                this.labelText.text = state.wireLabel;
                this.labelText.invalidate();
            }
        }
        if (state.labelOffset) {
            this.labelOffset = { x: state.labelOffset.x || 0, y: state.labelOffset.y || 0 };
        }
        this.invalidate();
    }

    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked', label: 'Locked', type: 'checkbox' },
        ];
    }

    // ─── Label text (separate Text shape) ────────────────────

    /**
     * Keep the label Text shape content in sync with wire state.
     */
    syncLabelText() {
        if (!this.labelText) return;
        this.labelText.text = this.wireLabel;
        this.labelText.invalidate();
    }

    /** Compute the centroid (average) of all node positions. */
    _getCentroid() {
        let sx = 0, sy = 0, n = 0;
        for (const p of this.nodes.values()) { sx += p.x; sy += p.y; n++; }
        return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
    }

    /**
     * Get the world-space position for the label text.
     * @returns {{x: number, y: number}}
     */
    getLabelPosition() {
        const c = this._getCentroid();
        return { x: c.x + this.labelOffset.x, y: c.y + this.labelOffset.y };
    }

    /* ──────────────────── SVG rendering ────────────────────────── */

    /** @override — adds blue tint when attached label is selected. */
    _updateElement(el, strokeColor, _fillColor, scale) {
        // When any attached label text is selected but the wire isn't, tint blue
        const attachedSelected = this.attachedLabels instanceof Set
            && Array.from(this.attachedLabels).some(label => label?.selected);
        if (!this.selected && !this.hovered && (this.labelText?.selected || attachedSelected)) {
            strokeColor = 'var(--sch-selection, #3399ff)';
        }
        super._updateElement(el, strokeColor, _fillColor, scale);
        // Pin-connection dots: mark each wire node that lands on a component
        // pin so it's visually clear the wire is actually connected (not just
        // crossing/touching). Sized to match the branch junction dots.
        if (this.pinConnections && this.pinConnections.size > 0) {
            const NS = 'http://www.w3.org/2000/svg';
            const r = Math.max(0.4, 2.5 / scale);
            for (const nid of this.pinConnections.keys()) {
                const pos = this.nodes.get(nid);
                if (!pos) continue;
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', pos.x);
                c.setAttribute('cy', pos.y);
                c.setAttribute('r', String(r));
                c.setAttribute('fill', strokeColor);
                c.setAttribute('stroke', 'none');
                c.classList.add('pin-connection-dot');
                el.appendChild(c);
            }
        }
        // Invalidate label text so it turns blue/normal with the wire
        if (this.labelText) this.labelText.invalidate();
    }

    /* ──────────────────── serialization ────────────────────────── */

    /**
     * Serialise to a compact JSON-friendly object.
     * Uses short keys (nd, ed, pc, wl, n) for file size.
     * @returns {object}
     */
    toJSON() {
        const json = { ...super.toJSON(), type: 'wire' };
        json.wl = this.wireLabel;
        if (this.pinConnections.size > 0) {
            json.pc = {};
            for (const [nid, c] of this.pinConnections) json.pc[nid] = { ...c };
        }
        if (this.net) json.n = this.net;
        if (this.labelOffset.x !== 0 || this.labelOffset.y !== WIRE_LABEL_DEFAULT_OFFSET_Y) {
            const r = v => Math.round(v * 10000) / 10000;
            json.lo = [r(this.labelOffset.x), r(this.labelOffset.y)];
        }
        return json;
    }
}
