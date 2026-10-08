import { viaCopperPathD } from './track-render.js';

/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('./autorouter-maze.js').RoutedTrack} RoutedTrack */
/** @typedef {{net?: string, pads?: Point[]}} RouteConnection */
/** @typedef {{type: string, done?: number, total?: number, net?: string, meta?: RouteProgressMeta, netTracks?: RoutedTrack[], conn?: RouteConnection, connId?: string, netName?: string, pendingConnections?: number, from?: Point, to?: Point}} RouterMessage */
/** @typedef {{phase?: string, pendingConnections?: number, pendingNets?: number, ripupDone?: number, ripupTotal?: number, ripupPass?: number, ripupMaxPasses?: number}} RouteProgressMeta */
/** @typedef {{done: number, total: number, netName: string, phase: string, pendingConnections: number, pendingNets: number, ripupDone: number, ripupTotal: number, ripupPass: number, ripupMaxPasses: number}} RouteProgressState */

/**
 * @typedef {object} AutorouterPresentationCapabilities
 * @property {() => HTMLElement|null} getProgressHost
 * @property {(id: string) => SVGElement|null} getLayerGroup
 * @property {() => SVGElement|null} getSvg
 * @property {() => RoutingParams} getRoutingParams
 * @property {() => void} refreshClearanceHalos
 *
 * @typedef {object} AutorouterPresentationRuntime
 * @property {() => number} now
 * @property {(callback: () => void, delay: number) => number} setInterval
 * @property {(id: number) => void} clearInterval
 * @property {(callback: () => void, delay: number) => number} setTimeout
 * @property {(id: number) => void} clearTimeout
 * @property {(callback: () => void) => number} requestAnimationFrame
 * @property {(id: number) => void} cancelAnimationFrame
 * @property {(tag: string) => SVGElement} createSvgElement
 */

/** Temporary routing artwork, ratline visibility and progress; no authored model access. */
export class AutorouterPresentation {
    /**
     * @param {AutorouterPresentationCapabilities} capabilities
     * @param {() => void} stop Cooperative session stop.
     * @param {Partial<AutorouterPresentationRuntime>} [runtime] Clock, scheduler and SVG factory overrides.
     */
    constructor(capabilities, stop, runtime = {}) {
        this.capabilities = capabilities;
        this.stop = stop;
        this.runtime = /** @type {AutorouterPresentationRuntime} */ ({
            now: () => performance.now(),
            setInterval: (callback, delay) => setInterval(callback, delay),
            clearInterval: id => clearInterval(id),
            setTimeout: (callback, delay) => setTimeout(callback, delay),
            clearTimeout: id => clearTimeout(id),
            requestAnimationFrame: callback => requestAnimationFrame(callback),
            cancelAnimationFrame: id => cancelAnimationFrame(id),
            createSvgElement: tag => document.createElementNS('http://www.w3.org/2000/svg', tag),
            ...runtime,
        });
        /** @type {RouteProgressState|null} */
        this._progress = null;
        this._startMs = 0;
        /** @type {number|null} */
        this._progressTimer = null;
        /** @type {Map<string, boolean>|null} */
        this._netUnrouted = null;
        this._lastBoundaryKey = '';
        /** @type {Map<string, boolean>} */
        this._visibilityQueue = new Map();
        this._visibilityFrame = 0;
        /** @type {Map<SVGElement, number>} */
        this._fadeFrames = new Map();
        /** @type {{id: number|null, resolve: () => void}|null} */
        this._phaseDelay = null;
        this._generation = 0;
        this._skipPhases = false;
    }

    start() {
        this._startMs = this.runtime.now();
        this._skipPhases = false;
        this.showProgress(0, 1, 'Starting...', {
            phase: 'initial', pendingConnections: 0, pendingNets: 0,
            ripupDone: 0, ripupTotal: 0, ripupPass: 0, ripupMaxPasses: 4,
        });
    }

    /** @param {Array<{net: string}>} connections */
    beginConnections(connections) {
        this._netUnrouted = new Map(connections.map(connection => [connection.net, true]));
        this._lastBoundaryKey = '';
        this.reconcileRouteVisibility();
    }

    /** @param {RouterMessage} message */
    handleMessage(message) {
        switch (message.type) {
            case 'progress':
                this.showProgress(message.done || 0, message.total || 0, message.net || '', message.meta || {});
                this.reconcilePhaseBoundary(message.done || 0, message.total || 0, message.meta || {});
                break;
            case 'netRouted': {
                const tracks = message.netTracks || [];
                this.clearTryingLines();
                for (const track of tracks) {
                    if (track.connId) this.clearIncrementalConnection(track.connId);
                }
                if (tracks[0]?.net) this.setNetUnrouted(tracks[0].net, false);
                this.renderNetTracks(tracks);
                break;
            }
            case 'netFailed':
                this.clearTryingLines();
                if (message.conn) this.flashFailedNet(message.conn);
                break;
            case 'connRipped':
                if (message.connId) this.clearIncrementalConnection(message.connId);
                break;
            case 'netPendingChanged':
                if (message.netName) {
                    const pendingConnections = message.pendingConnections || 0;
                    this.setNetUnrouted(message.netName, pendingConnections > 0);
                    this.setRatsnestVisibilityForNet(message.netName, pendingConnections > 0);
                }
                break;
            case 'trying':
                if (message.from && message.to) this.flashTryingLine(message.from, message.to);
                break;
        }
    }

    skipRemainingPhases() {
        this._skipPhases = true;
        if (this._phaseDelay) {
            if (this._phaseDelay.id !== null) this.runtime.clearTimeout(this._phaseDelay.id);
            this._phaseDelay.resolve();
            this._phaseDelay = null;
        }
    }

    finish() {
        this.flushRatsnestVisibilityQueue();
        this.reset();
    }

    reset() {
        this._generation++;
        this.skipRemainingPhases();
        if (this._visibilityFrame) this.runtime.cancelAnimationFrame(this._visibilityFrame);
        this._visibilityFrame = 0;
        this._visibilityQueue.clear();
        this._netUnrouted = null;
        this._lastBoundaryKey = '';
        this.clearIncrementalTracks();
        this.hideProgress();
    }

    dispose() { this.reset(); }

    /** @param {string} netName @param {boolean} isUnrouted */
    setNetUnrouted(netName, isUnrouted) {
        if (!this._netUnrouted || !netName) return;
        this._netUnrouted.set(netName, !!isUnrouted);
    }

    reconcileRouteVisibility() {
        if (!this._netUnrouted) return;
        const visibility = new Map();
        for (const [netName, isUnrouted] of this._netUnrouted.entries()) {
            visibility.set(netName, !!isUnrouted);
        }
        this.applyRatsnestVisibilityMap(visibility);
    }

    /** @param {number} done @param {number} total @param {RouteProgressMeta} [meta] */
    reconcilePhaseBoundary(done, total, meta = {}) {
        const phase = meta?.phase || 'initial';
        if (phase === 'initial' && total > 0 && done === total) {
            const key = 'initial:end';
            if (this._lastBoundaryKey === key) return;
            this._lastBoundaryKey = key;
            this.reconcileRouteVisibility();
            return;
        }

        if (phase === 'ripup') {
            const pass = Number.isFinite(meta?.ripupPass) ? Number(meta.ripupPass) : 0;
            const ripDone = Number.isFinite(meta?.ripupDone) ? Number(meta.ripupDone) : -1;
            const ripTotal = Number.isFinite(meta?.ripupTotal) ? Number(meta.ripupTotal) : -2;
            if (pass > 0 && ripTotal >= 0 && ripDone === ripTotal) {
                const key = `ripup:${pass}:end`;
                if (this._lastBoundaryKey === key) return;
                this._lastBoundaryKey = key;
                this.reconcileRouteVisibility();
            }
        }
    }

    /** @param {() => boolean} [isCurrent] */
    async finishRipupPhases(isCurrent = () => true) {
        const generation = this._generation;
        const state = this._progress;
        if (!state) return;
        const isRipup = state.phase === 'ripup' || String(state.netName || '').startsWith('Rip-up');
        if (!isRipup) return;

        const currentPass = Math.max(0, state.ripupPass || 0);
        const maxPasses = Math.max(0, state.ripupMaxPasses || 0);
        if (currentPass <= 0 || maxPasses <= currentPass) return;

        for (let p = currentPass + 1; p <= maxPasses; p++) {
            if (this._skipPhases || generation !== this._generation || !isCurrent()) return;
            this.showProgress(1, 1, `Rip-up pass ${p}`, {
                phase: 'ripup',
                pendingConnections: state.pendingConnections,
                pendingNets: state.pendingNets,
                ripupDone: 1,
                ripupTotal: 1,
                ripupPass: p,
                ripupMaxPasses: maxPasses,
            });
            await new Promise(resolve => {
                /** @type {{id: number|null, resolve: () => void}} */
                const delay = { id: null, resolve: () => resolve(undefined) };
                delay.id = this.runtime.setTimeout(() => {
                    if (this._phaseDelay === delay) this._phaseDelay = null;
                    resolve(undefined);
                }, 1000);
                this._phaseDelay = delay;
            });
        }
    }

    /**
     * Show routing progress in the status bar.
     * @param {number} done
     * @param {number} total
     * @param {string} netName
     * @param {RouteProgressMeta} [meta]
     */
    showProgress(done, total, netName, meta = {}) {
        /** @type {RouteProgressState} */
        const prev = this._progress || {
            done: 0,
            total: 1,
            netName: 'Starting...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
        const m = /** @type {{phase: string, pendingConnections: number, pendingNets: number, ripupDone: number, ripupTotal: number, ripupPass: number, ripupMaxPasses: number, currentIteration?: number, maxIterations?: number, trialIndex?: number, trialCount?: number, cleanCount?: number, totalCount?: number}} */ (meta || {});
        this._progress = {
            done,
            total,
            netName,
            phase: m.phase || prev.phase || 'initial',
            pendingConnections: Number.isFinite(m.pendingConnections) ? m.pendingConnections : (prev.pendingConnections || 0),
            pendingNets: Number.isFinite(m.pendingNets) ? m.pendingNets : (prev.pendingNets || 0),
            ripupDone: Number.isFinite(m.ripupDone) ? m.ripupDone : (prev.ripupDone || 0),
            ripupTotal: Number.isFinite(m.ripupTotal) ? m.ripupTotal : (prev.ripupTotal || 0),
            ripupPass: Number.isFinite(m.ripupPass) ? m.ripupPass : (prev.ripupPass || 0),
            ripupMaxPasses: Number.isFinite(m.ripupMaxPasses) ? m.ripupMaxPasses : (prev.ripupMaxPasses || 4),
        };
        const host = this.capabilities.getProgressHost();
        if (!host) return;

        // Only build the DOM structure once; update text/width on subsequent calls
        let bar = /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-bar-fill'));
        let label = /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-label'));
        let elapsed = /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-elapsed'));
        if (!bar) {
            host.innerHTML = `
                <span style="display:inline-flex;align-items:center;gap:8px">
                    <span class="route-progress-label"></span>
                    <span style="display:inline-block;width:80px;height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;vertical-align:middle">
                        <span class="route-progress-bar-fill" style="display:block;height:100%;width:0%;background:var(--accent-color);border-radius:3px;transition:width 0.15s"></span>
                    </span>
                    <span class="route-progress-elapsed" style="font-size:10px;color:var(--text-muted)">0:00</span>
                    <button id="pcbRouteCancelBtn" style="
                        background:none;border:1px solid var(--text-muted);color:var(--text-primary);
                        padding:1px 8px;border-radius:3px;font-size:10px;cursor:pointer;line-height:1.4;
                        transition: background 0.1s, color 0.1s;
                    ">Stop</button>
                </span>`;
            bar = /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-bar-fill'));
            label = /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-label'));
            elapsed = /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-elapsed'));

            const generation = this._generation;
            const cancelBtn = /** @type {HTMLButtonElement|null} */ (host.querySelector('#pcbRouteCancelBtn'));
            cancelBtn?.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                if (generation !== this._generation) return;
                this.stop();
                cancelBtn.style.background = '#d9534f';
                cancelBtn.style.borderColor = '#d9534f';
                cancelBtn.style.color = '#fff';
                cancelBtn.textContent = 'Stopping...';
                cancelBtn.disabled = true;
            });

            if (this._progressTimer !== null) this.runtime.clearInterval(this._progressTimer);
            this._progressTimer = this.runtime.setInterval(() => {
                if (generation === this._generation) this.refreshProgress();
            }, 250);
        }

        this.refreshProgress(label, bar, elapsed);
    }

    /** @param {HTMLElement|null} [labelEl] @param {HTMLElement|null} [barEl] @param {HTMLElement|null} [elapsedEl] */
    refreshProgress(labelEl = null, barEl = null, elapsedEl = null) {
        const host = this.capabilities.getProgressHost();
        if (!host) return;
        const state = this._progress || {
            done: 0,
            total: 1,
            netName: 'Routing...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
        const label = labelEl || /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-label'));
        const bar = barEl || /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-bar-fill'));
        const elapsed = elapsedEl || /** @type {HTMLElement|null} */ (host.querySelector('.route-progress-elapsed'));

        const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
        const isRipup = state.phase === 'ripup' || String(state.netName || '').startsWith('Rip-up');
        const isPathfinder = state.phase === 'pathfinder';
        let phaseLabel;
        if (isRipup) {
            phaseLabel = `Phase: Rip-up ${Math.max(1, state.ripupPass || 1)} of ${Math.max(1, state.ripupMaxPasses || 4)}`;
        } else if (isPathfinder) {
            // Pathfinder sends a self-describing netName (e.g. "Pathfinder iter 12/25: 950 overused").
            phaseLabel = `Phase: ${state.netName || 'Pathfinder'}`;
        } else {
            phaseLabel = 'Phase: Route placement';
        }
        const remainingConns = Math.max(0, Number.isFinite(state.pendingConnections) ? state.pendingConnections : (state.total - state.done));
        const progressLabel = `${pct}%`;
        if (label) {
            label.textContent = isPathfinder
                ? `${phaseLabel} - ${progressLabel} - ${remainingConns} pending`
                : `${phaseLabel} - ${state.done}/${state.total} (${pct}%) - ${remainingConns} connections unrouted`;
        }
        if (bar) bar.style.width = `${pct}%`;
        if (elapsed) {
            const t = Math.max(0, (this.runtime.now() - this._startMs) / 1000);
            const mins = Math.floor(t / 60);
            const secs = Math.floor(t % 60);
            elapsed.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        }
    }

    /**
     * Remove routing progress from the status bar.
     */
    hideProgress() {
        if (this._progressTimer !== null) {
            this.runtime.clearInterval(this._progressTimer);
            this._progressTimer = null;
        }
        this._progress = {
            done: 0,
            total: 1,
            netName: 'Starting...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
        const host = this.capabilities.getProgressHost();
        if (host) host.textContent = '';
    }

    /**
     * Render a single net's tracks incrementally during routing animation.
     * @param {RoutedTrack[]} netTracks
     */
    renderNetTracks(netTracks) {
        const topCopper = this.capabilities.getLayerGroup('top-copper');
        const bottomCopper = this.capabilities.getLayerGroup('bottom-copper');
        const params = this.capabilities.getRoutingParams();

        for (const track of netTracks) {
            if (track.points.length < 2) continue;
            const parent = track.layer === 'bottom' ? bottomCopper : topCopper;
            if (!parent) continue;
            const color = track.layer === 'bottom' ? '#0066ff' : '#ff3333';

            const polyline = this.runtime.createSvgElement('polyline');
            polyline.setAttribute('class', 'pcb-routed-track pcb-route-anim');
            const ptsStr = track.points.map(p => `${p.x},${p.y}`).join(' ');
            polyline.setAttribute('points', ptsStr);
            polyline.setAttribute('fill', 'none');
            polyline.setAttribute('stroke', color);
            polyline.setAttribute('stroke-width', String(params.trackWidth));
            polyline.setAttribute('stroke-linecap', 'round');
            polyline.setAttribute('stroke-linejoin', 'round');
            polyline.setAttribute('opacity', '0.6');
            if (track.net) polyline.dataset.net = track.net;
            if (track.connId) polyline.dataset.connid = track.connId;
            parent.appendChild(polyline);

            // Render vias for this track
            if (track.vias?.length) {
                const viaLayer = this.capabilities.getLayerGroup('vias');
                if (!viaLayer) continue;
                const viaRadius = params.viaDiameter / 2;
                const drillRadius = params.viaDrill / 2;
                for (const v of track.vias) {
                    const ring = this.runtime.createSvgElement('path');
                    ring.setAttribute('class', 'pcb-routed-via pcb-route-anim');
                    ring.setAttribute('d', viaCopperPathD({
                        x: v.x, y: v.y, diameter: viaRadius * 2, drill: drillRadius * 2,
                    }));
                    ring.setAttribute('fill-rule', 'evenodd');
                    ring.setAttribute('fill', '#b8860b');
                    ring.setAttribute('opacity', '0.6');
                    ring.setAttribute('data-via-x', String(v.x));
                    ring.setAttribute('data-via-y', String(v.y));
                    ring.setAttribute('data-via-radius', String(viaRadius));
                    if (track.net) ring.dataset.net = track.net;
                    if (track.connId) ring.dataset.connid = track.connId;
                    viaLayer.appendChild(ring);
                }
            }
        }
        this.capabilities.refreshClearanceHalos();
    }

    /** @param {string} netName */
    clearIncrementalNet(netName) {
        const svg = this.capabilities.getSvg();
        if (!netName || !svg) return;
        for (const el of svg.querySelectorAll(`.pcb-route-anim[data-net="${netName}"]`)) {
            this._removeArtwork(/** @type {SVGElement} */ (el));
        }
        this.capabilities.refreshClearanceHalos();
    }

    /** @param {string} connId */
    clearIncrementalConnection(connId) {
        const svg = this.capabilities.getSvg();
        if (!connId || !svg) return;
        for (const el of svg.querySelectorAll(`.pcb-route-anim[data-connid="${connId}"]`)) {
            this._removeArtwork(/** @type {SVGElement} */ (el));
        }
        this.capabilities.refreshClearanceHalos();
    }

    /**
     * Remove incremental animation tracks (replaced by final clean render).
     */
    clearIncrementalTracks() {
        for (const frame of this._fadeFrames.values()) this.runtime.cancelAnimationFrame(frame);
        this._fadeFrames.clear();
        const anims = this.capabilities.getSvg()?.querySelectorAll('.pcb-route-anim');
        if (anims) {
            for (const el of anims) el.remove();
        }
        this.capabilities.refreshClearanceHalos();
    }

    /**
     * Show a brief "trying" line for a connection being attempted.
     * @param {Point} from @param {Point} to
     */
    flashTryingLine(from, to) {
        const layer = this.capabilities.getLayerGroup('ratlines');
        if (!layer) return;

        // Remove all previous trying lines
        for (const el of layer.querySelectorAll('.pcb-trying-line')) el.remove();

        const line = this.runtime.createSvgElement('line');
        line.setAttribute('class', 'pcb-route-anim pcb-trying-line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('stroke', '#ffcc00');
        line.setAttribute('stroke-width', '0.2');
        line.setAttribute('opacity', '0.8');
        layer.appendChild(line);
    }

    /**
     * Remove all trying lines.
     */
    clearTryingLines() {
        const layer = this.capabilities.getLayerGroup('ratlines');
        if (layer) {
            for (const el of layer.querySelectorAll('.pcb-trying-line')) el.remove();
        }
    }

    /**
     * Flash a failed net's ratline(s) in yellow.
     * @param {RouteConnection} conn
     */
    flashFailedNet(conn) {
        if (!conn.pads || conn.pads.length < 2) return;
        const layer = this.capabilities.getLayerGroup('ratlines');
        if (!layer) return;

        // Keep failed overlays bounded and replace previous overlays for this net.
        const netName = conn.net || '';
        if (netName) {
            for (const old of layer.querySelectorAll(`.pcb-failed-line[data-net="${netName}"]`)) {
                this._removeArtwork(/** @type {SVGElement} */ (old));
            }
        }
        const allFailed = layer.querySelectorAll('.pcb-failed-line');
        if (allFailed.length > 24) {
            const toRemove = allFailed.length - 24;
            for (let i = 0; i < toRemove; i++) this._removeArtwork(/** @type {SVGElement} */ (allFailed[i]));
        }

        for (let i = 0; i < conn.pads.length - 1; i++) {
            const from = conn.pads[i];
            const to = conn.pads[i + 1];

            const line = this.runtime.createSvgElement('line');
            line.setAttribute('class', 'pcb-route-anim pcb-failed-line');
            if (netName) line.dataset.net = netName;
            line.setAttribute('x1', String(from.x));
            line.setAttribute('y1', String(from.y));
            line.setAttribute('x2', String(to.x));
            line.setAttribute('y2', String(to.y));
            line.setAttribute('stroke', '#ffcc00');
            line.setAttribute('stroke-width', '0.3');
            line.setAttribute('opacity', '0.9');
            layer.appendChild(line);

            // Fade out and remove
            const generation = this._generation;
            let opacity = 0.9;
            const fade = () => {
                if (generation !== this._generation || !this._fadeFrames.has(line)) return;
                opacity -= 0.08;
                if (opacity <= 0) {
                    this._removeArtwork(line);
                    return;
                }
                line.setAttribute('opacity', String(opacity));
                this._fadeFrames.set(line, this.runtime.requestAnimationFrame(fade));
            };
            this._fadeFrames.set(line, this.runtime.requestAnimationFrame(fade));
        }
    }

    /** @param {string} netName */
    hideRatsnestForNet(netName) {
        this.setRatsnestVisibilityForNet(netName, false);
    }

    /** @param {string} netName @param {boolean} visible */
    setRatsnestVisibilityForNet(netName, visible) {
        if (!netName) return;
        this._visibilityQueue.set(netName, !!visible);
        if (this._visibilityFrame) return;
        const generation = this._generation;
        this._visibilityFrame = this.runtime.requestAnimationFrame(() => {
            if (generation !== this._generation) return;
            this._visibilityFrame = 0;
            this.flushRatsnestVisibilityQueue();
        });
    }

    flushRatsnestVisibilityQueue() {
        if (!this._visibilityQueue.size) return;
        const updates = new Map(this._visibilityQueue);
        this._visibilityQueue.clear();
        this.applyRatsnestVisibilityMap(updates);
    }

    /** @param {Map<string, boolean>} visibilityByNet */
    applyRatsnestVisibilityMap(visibilityByNet) {
        if (!visibilityByNet || !visibilityByNet.size) return;
        const ratLayer = this.capabilities.getLayerGroup('ratlines');
        if (!ratLayer) return;
        for (const line of ratLayer.querySelectorAll('.ratsnest-line')) {
            const net = /** @type {HTMLElement} */ (line).dataset.net || '';
            if (!visibilityByNet.has(net)) continue;
            /** @type {HTMLElement} */ (line).style.display = visibilityByNet.get(net) ? '' : 'none';
        }
        for (const el of ratLayer.children) {
            if (el.tagName !== 'text') continue;
            const net = (el.textContent || '').trim();
            if (!visibilityByNet.has(net)) continue;
            /** @type {HTMLElement} */ (el).style.display = visibilityByNet.get(net) ? '' : 'none';
        }
    }

    /** @param {SVGElement|null|undefined} element */
    _removeArtwork(element) {
        if (!element) return;
        if (this._fadeFrames.has(element)) {
            const frame = this._fadeFrames.get(element);
            if (frame !== undefined) this.runtime.cancelAnimationFrame(frame);
            this._fadeFrames.delete(element);
        }
        element.remove();
    }
}
