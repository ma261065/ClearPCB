/**
 * @typedef {object} DrcPresentationCapabilities
 * @property {() => void} requestRefresh Ask the existing DRC scheduler for fresh results.
 * @property {() => Array<{net:string,x1:number,y1:number,x2:number,y2:number}>} collectRatlines
 * @property {() => void} clearBoardSelection Clear board interaction/properties, not DRC selection.
 * @property {(id:'drc-overlay'|'ratlines', create?:boolean) => SVGElement|null} getLayerGroup
 * @property {() => DrcViewport|null} getViewport Viewbox, SVG and screen conversion/navigation only.
 * @property {(violation:object) => object|null} [resolvePairMarker] Recheck the selected pair's displayed copper.
 *
 * @typedef {object} DrcViewport
 * @property {{x:number,y:number,width:number,height:number}} viewBox
 * @property {SVGElement} svg
 * @property {number} scale
 * @property {((point:{x:number,y:number}) => {x:number,y:number})|null} worldToScreen
 * @property {() => void} updateViewBox
 * @property {() => void} notifyViewChanged
 */

/** DRC UI ownership. Computation, worker revisions and refresh debt stay in drc-refresh. */
export class DrcPresentation {
    /** @param {DrcPresentationCapabilities} capabilities @param {Document} [dom] */
    constructor(capabilities, dom = globalThis.document) {
        this.capabilities = capabilities;
        this.dom = dom;
        this.violations = [];
        this.selectedId = null;
        this.designActive = false;
        this.collapsedGroups = new Set();
        this.connectorSvg = null;
        this.connectorLine = null;
        this.pending = false;
        this.error = null;
        this.initialized = false;
        this.disposed = false;
        this.suspended = false;
        this.listeners = [];
        this.rowListeners = [];
        this.markerFrame = null;
        this.markerPreview = null;
    }

    listen(target, type, callback, options, listeners = this.listeners) {
        if (!target) return;
        const guarded = event => {
            if (!this.disposed && !this.suspended) callback(event);
        };
        target.addEventListener(type, guarded, options);
        listeners.push(() => target.removeEventListener?.(type, guarded, options));
    }

    deactivate() {
        this.suspended = true;
        this.cancelMarkerRefresh();
        this.clearMarker();
    }

    activate() {
        if (this.disposed) return;
        this.suspended = false;
        this.refreshSelectedMarker();
    }

    refreshSelectedMarker() {
        const selected = this.selectedMarker();
        const group = selected?.rule === 'short' ? 'Shorted Nets'
            : selected?.rule === 'unrouted' ? 'Incomplete Connections' : 'Clearance';
        if (this.disposed || this.suspended || !selected || this.collapsedGroups.has(group)) {
            this.clearMarker();
            return;
        }
        this.drawMarker(selected);
        this.updateConnector();
    }

    selectedMarker() {
        return this.markerPreview?.id === this.selectedId ? this.markerPreview.violation
            : this.violations.find(v => v.id === this.selectedId);
    }

    cancelMarkerRefresh() {
        if (this.markerFrame) cancelAnimationFrame(this.markerFrame.handle);
        this.markerFrame = null;
        this.markerPreview = null;
    }

    scheduleMarkerRefresh() {
        const selected = this.violations.find(v => v.id === this.selectedId);
        const group = selected?.rule === 'short' ? 'Shorted Nets' : 'Clearance';
        if (this.disposed || this.suspended || !selected?.marker?.pair
            || this.collapsedGroups.has(group) || !this.capabilities.resolvePairMarker || this.markerFrame) return;
        const frame = { id: selected.id, handle: 0 };
        this.markerFrame = frame;
        frame.handle = requestAnimationFrame(() => {
            if (this.markerFrame !== frame) return;
            this.markerFrame = null;
            if (this.disposed || this.suspended || this.selectedId !== frame.id) return;
            try {
                this.markerPreview = { id: frame.id, violation: this.capabilities.resolvePairMarker(selected) };
                this.refreshSelectedMarker();
            } catch (error) {
                console.error('[DRC] live marker check failed', error);
                this.markerPreview = { id: frame.id, violation: null };
                this.clearMarker();
            }
        });
    }

    overlayVisibilityChanged() {
        if (this.capabilities.getLayerGroup('drc-overlay')?.firstChild) this.refreshSelectedMarker();
    }

    setDesignActive(active) {
        this.designActive = active;
        if (active && !this.disposed && !this.suspended) this.capabilities.requestRefresh();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelMarkerRefresh();
        for (const remove of this.listeners.splice(0)) remove();
        for (const remove of this.rowListeners.splice(0)) remove();
        this.closePanel();
        this.clearMarker();
        this.connectorSvg?.remove();
        this.connectorSvg = null;
        this.connectorLine = null;
        this.dom.getElementById('pcbDrcList')?.replaceChildren?.();
        this.violations = [];
        this.selectedId = null;
        this.collapsedGroups.clear();
    }

    initialize() {
        if (this.disposed || this.initialized) return;
        this.initialized = true;
        /** @type {Array} */
        this.violations = [];
        this.designActive = false;
        this.selectedId = null;
        /** @type {Set<string>} Collapsed problem-list section headings. */
        this.collapsedGroups = new Set();

        const statusBtn = this.dom.getElementById('pcbDrcStatus');
        const closeBtn = this.dom.getElementById('pcbDrcSlideClose');
        this.listen(statusBtn, 'click', (e) => {
            e.stopPropagation();
            this.togglePanel();
        });
        this.listen(closeBtn, 'click', (e) => {
            e.stopPropagation();
            this.closePanel();
        });
        const slidePanel = this.dom.getElementById('pcbDrcSlidePanel');
        const clearBoardSelection = () => this.capabilities.clearBoardSelection();
        slidePanel?.setAttribute('tabindex', '-1');
        this.listen(slidePanel, 'pointerdown', () => {
            clearBoardSelection();
            slidePanel.focus({ preventScroll: true });
        }, { capture: true });
        this.listen(slidePanel, 'focusin', clearBoardSelection);
        this.listen(slidePanel, 'keydown', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            e.stopPropagation();
            this.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        });

        // Suppress the browser/app context menu on the DRC panel.
        this.listen(slidePanel, 'contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        // Keep the leader anchored to its row as the problem list scrolls.
        const body = this.dom.querySelector('#pcbDrcSlidePanel .drc-slide-body');
        this.listen(body, 'scroll', () => {
            if (this.selectedId) this.updateConnector();
        }, { passive: true });

        // Re-run when the design rules themselves change.
        for (const id of ['pcbClearance', 'pcbViaDiameter', 'pcbViaDrill', 'pcbRouteUnits']) {
            const el = this.dom.getElementById(id);
            this.listen(el, 'change', () => this.capabilities.requestRefresh());
        }

        this.updateStatus({ ok: true, violations: [], counts: { errors: 0, warnings: 0 } }, true);
    }

    shouldRun() {
        if (this.disposed || this.suspended) return false;
        if (this.designActive) return true;
        const panel = this.dom.getElementById('pcbDrcSlidePanel');
        return !!panel && panel.classList.contains('open');
    }

    adoptResult(result) {
        if (this.disposed) return;
        this.cancelMarkerRefresh();
        // Capture the currently-selected violation before the list is replaced,
        // so a coordinate-keyed ratline that gets renumbered can be re-adopted.
        const prevSel = this.selectedId
            ? this.violations?.find(v => v.id === this.selectedId)
            : null;
        this.violations = result.violations;
        this.updateStatus(result);
        this.renderList();

        // Keep the selected marker in sync: if the violation still exists,
        // redraw it at its (possibly moved) location; otherwise drop it.
        if (this.selectedId) {
            let sel = this.violations.find(v => v.id === this.selectedId);
            // An incomplete-connection violation's id is keyed on its endpoint
            // coordinates, so moving the connected copper renumbers it — the
            // old id vanishes on re-run. Re-adopt the equivalent fresh ratline
            // (same net, nearest endpoints) so the selection survives the drop.
            if (!sel) {
                sel = this.rematchRatlineViolation(prevSel);
                if (sel) {
                    this.selectedId = sel.id;
                    this.renderList();
                }
            }
            if (sel) {
                this.refreshSelectedMarker();
            } else {
                this.selectedId = null;
                this.clearMarker();
            }
        }
    }

    rematchRatlineViolation(prev) {
        const pm = prev?.marker;
        if (!pm || pm.type !== 'ratline' || !pm.a || !pm.b) return null;
        const net = pm.net || '';
        const dist2 = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
        let best = null, bestD = Infinity;
        for (const v of this.violations) {
            const m = v.marker;
            if (v.rule !== 'unrouted' || !m || m.type !== 'ratline') continue;
            if ((m.net || '') !== net || !m.a || !m.b) continue;
            const d = Math.min(
                dist2(m.a, pm.a) + dist2(m.b, pm.b),
                dist2(m.a, pm.b) + dist2(m.b, pm.a),
            );
            if (d < bestD) { bestD = d; best = v; }
        }
        return best;
    }

    updateStatus(result, pending = false) {
        if (this.disposed) return;
        const btn = this.dom.getElementById('pcbDrcStatus');
        const icon = this.dom.getElementById('pcbDrcIcon');
        const label = this.dom.getElementById('pcbDrcLabel');
        if (!btn || !icon || !label) return;

        btn.classList.remove('drc-status-pending', 'drc-status-ok', 'drc-status-error', 'drc-status-warn');

        if (pending) {
            btn.classList.add('drc-status-pending');
            icon.textContent = '…';
            label.textContent = this.error ? 'DRC check failed' : 'Checking…';
            return;
        }

        const { errors, warnings } = result.counts;
        if (errors === 0 && warnings === 0) {
            btn.classList.add('drc-status-ok');
            icon.textContent = '✓';
            label.textContent = 'No DRC errors';
        } else if (errors > 0) {
            btn.classList.add('drc-status-error');
            icon.textContent = '✕';
            const w = warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
            label.textContent = `${errors} error${errors === 1 ? '' : 's'}${w}`;
        } else {
            btn.classList.add('drc-status-warn');
            icon.textContent = '!';
            label.textContent = `${warnings} warning${warnings === 1 ? '' : 's'}`;
        }
    }

    renderList() {
        if (this.disposed) return;
        for (const remove of this.rowListeners.splice(0)) remove();
        const list = this.dom.getElementById('pcbDrcList');
        const empty = this.dom.getElementById('pcbDrcEmpty');
        if (!list || !empty) return;
        list.textContent = '';

        const title = this.dom.getElementById('pcbDrcSlideTitle');
        if (title) {
            const n = this.violations.length;
            title.textContent = n === 0
                ? 'Design Rule Check'
                : `Design Rule Check — ${n} problem${n === 1 ? '' : 's'}`;
        }

        if (this.violations.length === 0) {
            empty.removeAttribute('hidden');
            empty.style.display = '';
            return;
        }
        empty.setAttribute('hidden', '');
        empty.style.display = 'none';

        // Group violations under section headings. Sections appear only when
        // they have at least one violation (built from the data below), so an
        // empty category never shows a header. Shorted nets are listed first
        // (highest severity), then clearance, then incomplete connections.
        const groupOf = (v) => {
            if (v.rule === 'short') return 'Shorted Nets';
            if (v.rule === 'unrouted') return 'Incomplete Connections';
            return 'Clearance';
        };
        const ORDER = ['Shorted Nets', 'Clearance', 'Incomplete Connections'];

        // Cap the rendered rows so a pathological board (thousands of
        // violations) can't bloat the DOM and stall the UI. Prioritize first:
        // the engine emits shorts last, after potentially hundreds of ratlines.
        const MAX_ROWS = 200;
        const shown = [...this.violations]
            .sort((a, b) => ORDER.indexOf(groupOf(a)) - ORDER.indexOf(groupOf(b)))
            .slice(0, MAX_ROWS);

        const groups = new Map();
        for (const v of shown) {
            const g = groupOf(v);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(v);
        }
        const names = [...ORDER.filter(n => groups.has(n)), ...[...groups.keys()].filter(n => !ORDER.includes(n))];

        for (const name of names) {
            const collapsed = this.collapsedGroups.has(name);
            const heading = this.dom.createElement('li');
            heading.className = 'drc-group-heading' + (collapsed ? ' drc-group-collapsed' : '');
            heading.setAttribute('role', 'button');
            heading.setAttribute('tabindex', '0');
            heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

            const chevron = this.dom.createElement('span');
            chevron.className = 'drc-group-chevron';
            chevron.textContent = '▸';
            const label = this.dom.createElement('span');
            label.className = 'drc-group-label';
            label.textContent = `${name} (${groups.get(name).length})`;
            heading.appendChild(chevron);
            heading.appendChild(label);

            const toggle = () => {
                if (this.collapsedGroups.has(name)) this.collapsedGroups.delete(name);
                else this.collapsedGroups.add(name);
                this.renderList();
                // If the selected violation now sits in a collapsed section,
                // stop showing its on-board marker + leader; restore them when
                // its section is expanded again.
                const sel = this.selectedId
                    ? this.violations.find(x => x.id === this.selectedId) : null;
                if (sel && this.collapsedGroups.has(groupOf(sel))) {
                    this.clearMarker();
                } else if (sel) {
                    this.drawMarker(sel);
                    this.updateConnector();
                }
            };
            this.listen(heading, 'click', toggle, undefined, this.rowListeners);
            this.listen(heading, 'keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            }, undefined, this.rowListeners);
            list.appendChild(heading);

            if (collapsed) continue;

            for (const v of groups.get(name)) {
                const li = this.dom.createElement('li');
                li.className = `drc-item drc-item-${v.severity === 'error' ? 'error' : 'warn'}`;
                li.dataset.drcId = v.id;
                li.tabIndex = v.id === this.selectedId ? 0 : -1;
                if (v.id === this.selectedId) li.classList.add('drc-item-active');

                const dot = this.dom.createElement('span');
                dot.className = 'drc-item-dot';
                const text = this.dom.createElement('span');
                text.className = 'drc-item-text';
                text.textContent = v.message;
                li.appendChild(dot);
                li.appendChild(text);

                this.listen(li, 'click', () => {
                    this.selectViolation(v.id);
                    li.focus();
                }, undefined, this.rowListeners);
                list.appendChild(li);
            }
        }

        if (this.violations.length > MAX_ROWS) {
            const more = this.dom.createElement('li');
            more.className = 'drc-panel-empty';
            more.style.cursor = 'default';
            more.textContent = `…and ${this.violations.length - MAX_ROWS} more`;
            list.appendChild(more);
        }
    }

    togglePanel() {
        const panel = this.dom.getElementById('pcbDrcSlidePanel');
        if (!panel) return;
        if (panel.classList.contains('open')) this.closePanel();
        else this.openPanel();
    }

    openPanel() {
        if (this.disposed || this.suspended) return;
        const panel = this.dom.getElementById('pcbDrcSlidePanel');
        const btn = this.dom.getElementById('pcbDrcStatus');
        if (!panel) return;
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        btn?.setAttribute('aria-expanded', 'true');
        btn?.classList.add('drc-status-active');
        this.capabilities.requestRefresh();
    }

    closePanel() {
        this.cancelMarkerRefresh();
        const panel = this.dom.getElementById('pcbDrcSlidePanel');
        const btn = this.dom.getElementById('pcbDrcStatus');
        panel?.classList.remove('open');
        panel?.setAttribute('aria-hidden', 'true');
        btn?.setAttribute('aria-expanded', 'false');
        btn?.classList.remove('drc-status-active');
        // Closing the panel clears the on-board violation marker(s)/leader.
        this.selectedId = null;
        this.clearMarker();
    }

    moveSelection(direction) {
        if (this.disposed || this.suspended) return;
        const list = this.dom.getElementById('pcbDrcList');
        if (!list) return;
        const rows = [...list.querySelectorAll('.drc-item')];
        if (rows.length === 0) return;
        const current = rows.findIndex(row => row.dataset.drcId === this.selectedId);
        const next = current < 0
            ? (direction > 0 ? 0 : rows.length - 1)
            : Math.max(0, Math.min(rows.length - 1, current + direction));
        const row = rows[next];
        this.selectViolation(row.dataset.drcId);
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
    }

    selectViolation(id) {
        if (this.disposed || this.suspended) return;
        const v = this.violations.find(x => x.id === id);
        if (!v) return;
        this.cancelMarkerRefresh();
        this.selectedId = id;

        // Re-flag the active list row.
        const list = this.dom.getElementById('pcbDrcList');
        if (list) {
            for (const li of list.querySelectorAll('.drc-item')) {
                const active = li.dataset.drcId === id;
                li.classList.toggle('drc-item-active', active);
                li.tabIndex = active ? 0 : -1;
            }
        }

        this.drawMarker(v);
        this.ensurePointVisible(v.x, v.y);
        this.updateConnector();
    }

    drawMarker(v) {
        if (this.disposed || this.suspended) return;
        const NS = 'http://www.w3.org/2000/svg';
        const overlay = this.capabilities.getLayerGroup('drc-overlay', true);
        if (!overlay) return;
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

        const COLOR = '#ffd400';
        const dot = (x, y, r, dash) => {
            const c = this.dom.createElementNS(NS, 'circle');
            c.setAttribute('cx', String(x));
            c.setAttribute('cy', String(y));
            c.setAttribute('r', String(r));
            c.setAttribute('fill', 'none');
            c.setAttribute('stroke', COLOR);
            c.setAttribute('stroke-width', '1.5');
            c.setAttribute('vector-effect', 'non-scaling-stroke');
            if (dash) c.setAttribute('stroke-dasharray', dash);
            c.setAttribute('pointer-events', 'none');
            overlay.appendChild(c);
        };

        // One location ring, including the detected contact for a short.
        const m = v.marker || {};
        const ringR = (m.type === 'ring') ? (m.r || 0.3) + 0.25 : 0.6;
        dot(v.x, v.y, ringR, '3,2');

        // For an incomplete-connection (ratline) violation, the actual air
        // wire may be hidden (Ratlines overlay off, or this net's ratline
        // toggled off). Re-draw just this one ratline on the overlay so the
        // user can see what is unconnected — only while it stays highlighted.
        if (m.type === 'ratline' && m.a && m.b && !this.isRatlineVisible(m.a, m.b)) {
            const line = this.dom.createElementNS(NS, 'line');
            line.setAttribute('x1', String(m.a.x));
            line.setAttribute('y1', String(m.a.y));
            line.setAttribute('x2', String(m.b.x));
            line.setAttribute('y2', String(m.b.y));
            line.setAttribute('stroke', '#4488ff');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            overlay.appendChild(line);
        }
    }

    isRatlineVisible(a, b) {
        const layer = this.capabilities.getLayerGroup('ratlines');
        if (!layer || layer.style.display === 'none') return false;
        const near = (p, q) => Math.abs(p - q) < 1e-3;
        for (const el of layer.querySelectorAll('line.ratsnest-line, line.ratsnest-failed')) {
            if (/** @type {HTMLElement} */ (el).style.display === 'none') continue;
            const x1 = parseFloat(el.getAttribute('x1'));
            const y1 = parseFloat(el.getAttribute('y1'));
            const x2 = parseFloat(el.getAttribute('x2'));
            const y2 = parseFloat(el.getAttribute('y2'));
            if ((near(x1, a.x) && near(y1, a.y) && near(x2, b.x) && near(y2, b.y)) ||
                (near(x1, b.x) && near(y1, b.y) && near(x2, a.x) && near(y2, a.y))) {
                return true;
            }
        }
        return false;
    }

    clearMarker() {
        const overlay = this.capabilities.getLayerGroup('drc-overlay');
        if (overlay) while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
        this.hideConnector();
    }

    ensureConnector() {
        if (this.disposed || this.suspended) return null;
        if (this.connectorSvg) return this.connectorSvg;
        const container = this.capabilities.getViewport()?.svg?.parentElement?.parentElement; // .main-container
        if (!container) return null;
        const NS = 'http://www.w3.org/2000/svg';
        const svg = this.dom.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'drc-connector-svg');
        svg.style.position = 'absolute';
        svg.style.inset = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'none';
        svg.style.zIndex = '60';
        svg.style.display = 'none';
        const line = this.dom.createElementNS(NS, 'polyline');
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', '#ffd400');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '4,3');
        svg.appendChild(line);
        container.appendChild(svg);
        this.connectorSvg = svg;
        this.connectorLine = line;
        return svg;
    }

    hideConnector() {
        if (this.connectorSvg) this.connectorSvg.style.display = 'none';
    }

    updateConnector() {
        const id = this.selectedId;
        const panel = this.dom.getElementById('pcbDrcSlidePanel');
        const v = id ? this.selectedMarker() : null;
        // Only show while the panel is open and a violation is selected.
        const group = v?.rule === 'short' ? 'Shorted Nets'
            : v?.rule === 'unrouted' ? 'Incomplete Connections' : 'Clearance';
        if (this.disposed || this.suspended || this.collapsedGroups.has(group)
            || !v || !panel || !panel.classList.contains('open')) {
            this.hideConnector();
            return;
        }
        const svg = this.ensureConnector();
        const viewport = this.capabilities.getViewport();
        if (!svg || !viewport?.worldToScreen) return;

        const row = panel.querySelector(`.drc-item[data-drc-id="${id}"]`);
        const containerRect = svg.parentElement.getBoundingClientRect();
        const vpSvg = viewport.svg;
        const sp = viewport.worldToScreen({ x: v.x, y: v.y });
        const svgRect = vpSvg.getBoundingClientRect();
        // Marker position in container-local coordinates.
        const ex = (svgRect.left - containerRect.left) + sp.x;
        const ey = (svgRect.top - containerRect.top) + sp.y;        // Start point: right edge of the selected row so the leader meets the
        // marker from the right side of the list. Clamp vertically to the
        // scrollable body so it never spills over the header/footer when the
        // row is scrolled out of view.
        const body = panel.querySelector('.drc-slide-body');
        const startRect = (row || panel).getBoundingClientRect();
        const sx = startRect.right - containerRect.left - 16;
        let sy = (row ? (startRect.top + startRect.height / 2) : (startRect.top + 24)) - containerRect.top;
        let rowVisible = true;
        if (body) {
            const b = body.getBoundingClientRect();
            const top = b.top - containerRect.top;
            const bottom = b.bottom - containerRect.top;
            // The row is "off the list" when its center sits outside the body.
            if (row) {
                const rowCenter = startRect.top + startRect.height / 2;
                rowVisible = rowCenter >= b.top && rowCenter <= b.bottom;
            }
            sy = Math.max(top, Math.min(bottom, sy));
        }

        // Dim the leader when its row is scrolled out of view.
        this.connectorLine.setAttribute('stroke-opacity', rowVisible ? '1' : '0.3');
        // Stop the leader at the edge of the marker ring (not its center).
        const m = v.marker || {};
        const ringR = (m.type === 'ring') ? (m.r || 0.3) + 0.25 : 0.6;
        const screenR = ringR * (viewport.scale || 1);
        let tx = ex, ty = ey;
        const dx = ex - sx, dy = ey - sy;
        const dist = Math.hypot(dx, dy);
        if (dist > screenR) {
            tx = ex - (dx / dist) * screenR;
            ty = ey - (dy / dist) * screenR;
        }
        this.connectorLine.setAttribute('points', `${sx},${sy} ${tx},${ty}`);
        svg.style.display = '';
    }

    ensurePointVisible(x, y) {
        const vp = this.capabilities.getViewport();
        if (!vp || !vp.viewBox) return;
        const vb = vp.viewBox;
        let leftInset = 0;
        const panel = this.dom.getElementById('pcbDrcSlidePanel');
        if (panel?.classList.contains('open')) {
            const rect = vp.svg?.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            if (rect?.width > 0 && panelRect.width > 0 && panel.offsetParent &&
                panelRect.bottom > rect.top && panelRect.top < rect.top + rect.height) {
                // Use the settled left-docked position, even during the slide-in animation.
                const panelRight = panel.offsetParent.getBoundingClientRect().left +
                    panel.offsetLeft + panelRect.width;
                leftInset = Math.max(0, Math.min(1, (panelRight - rect.left) / rect.width)) * vb.width;
            }
        }
        const visibleWidth = vb.width - leftInset;
        const margin = Math.min(visibleWidth, vb.height) * 0.12;
        const inside = x >= vb.x + leftInset + margin && x <= vb.x + vb.width - margin &&
            y >= vb.y + margin && y <= vb.y + vb.height - margin;
        if (inside) return;
        // Center within the uncovered area without changing the scale.
        vb.x = x - leftInset - visibleWidth / 2;
        vb.y = y - vb.height / 2;
        vp.updateViewBox?.();
        vp.notifyViewChanged?.();
    }

    followRatline() {
        if (this.disposed || this.suspended) return;
        const sel = this.violations?.find(v => v.id === this.selectedId);
        const m = sel?.marker;
        if (!m || m.type !== 'ratline' || !m.a || !m.b) return;

        const net = m.net || '';
        const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
        let best = null, bestD = Infinity;
        for (const r of this.capabilities.collectRatlines()) {
            if ((r.net || '') !== net) continue;
            if (![r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) continue;
            const dA = dist2(r.x1, r.y1, m.a.x, m.a.y) + dist2(r.x2, r.y2, m.b.x, m.b.y);
            const dB = dist2(r.x1, r.y1, m.b.x, m.b.y) + dist2(r.x2, r.y2, m.a.x, m.a.y);
            const d = Math.min(dA, dB);
            if (d < bestD) {
                bestD = d;
                best = (dA <= dB)
                    ? { a: { x: r.x1, y: r.y1 }, b: { x: r.x2, y: r.y2 } }
                    : { a: { x: r.x2, y: r.y2 }, b: { x: r.x1, y: r.y1 } };
            }
        }
        if (!best) return;

        m.a = best.a;
        m.b = best.b;
        sel.x = (best.a.x + best.b.x) / 2;
        sel.y = (best.a.y + best.b.y) / 2;
        this.refreshSelectedMarker();
    }
}
