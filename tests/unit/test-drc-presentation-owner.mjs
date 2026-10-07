import assert from 'node:assert/strict';
import { DrcPresentation } from '../../src/pcb/modules/drc-presentation.js';

class Element {
    constructor(tag = 'div') {
        this.tag = tag;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.className = '';
        this.events = new Map();
        this.rect = { left: 0, top: 0, right: 320, bottom: 600, width: 320, height: 600 };
        this.classList = {
            contains: name => this.className.split(' ').includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' '); },
            toggle: (name, enabled) => this.classList[enabled ? 'add' : 'remove'](name),
        };
    }
    set textContent(value) { this.text = value; this.replaceChildren(); }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; }
    replaceChildren() { for (const child of [...this.children]) this.removeChild(child); }
    remove() { this.parentElement?.removeChild(this); }
    get firstChild() { return this.children[0]; }
    addEventListener(type, handler, options) {
        const listeners = this.events.get(type) || [];
        listeners.push({ handler, options });
        this.events.set(type, listeners);
    }
    removeEventListener(type, handler, options) {
        this.events.set(type, (this.events.get(type) || []).filter(entry =>
            entry.handler !== handler || entry.options !== options));
    }
    fire(type, event = {}) {
        for (const { handler } of this.events.get(type) || []) handler({
            preventDefault() {}, stopPropagation() {}, ...event,
        });
    }
    querySelectorAll(selector) {
        if (selector === '.drc-item') return this.children.filter(child => child.dataset.drcId);
        return this.children.filter(child => child.tag === 'line');
    }
    querySelector(selector) {
        if (selector === '.drc-slide-body') return this.body || null;
        const id = selector.match(/data-drc-id="([^"]+)"/)?.[1];
        return this.list?.querySelectorAll('.drc-item').find(row => row.dataset.drcId === id) || null;
    }
    getBoundingClientRect() { return this.rect; }
    focus(options) { this.focused = options || true; }
    scrollIntoView(options) { this.scrolled = options; }
    listenerCount() { return [...this.events.values()].reduce((sum, list) => sum + list.length, 0); }
}

function fixture(extraCapabilities = {}) {
    const ids = ['pcbDrcStatus', 'pcbDrcIcon', 'pcbDrcLabel', 'pcbDrcSlideClose', 'pcbDrcSlidePanel',
        'pcbDrcList', 'pcbDrcEmpty', 'pcbDrcSlideTitle', 'pcbClearance', 'pcbViaDiameter', 'pcbViaDrill', 'pcbRouteUnits'];
    const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
    const all = Object.values(elements);
    const body = new Element(), overlay = new Element('g'), rats = new Element('g');
    const container = new Element(), host = new Element(), svg = new Element('svg');
    container.appendChild(host);
    host.appendChild(svg);
    svg.rect = { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 };
    const panel = elements.pcbDrcSlidePanel;
    panel.body = body;
    panel.list = elements.pcbDrcList;
    panel.offsetParent = container;
    panel.offsetLeft = 0;
    all.push(body);
    const dom = {
        getElementById: id => elements[id] || null,
        querySelector: () => body,
        createElement: tag => { const el = new Element(tag); all.push(el); return el; },
        createElementNS: (_, tag) => { const el = new Element(tag); all.push(el); return el; },
    };
    let refreshes = 0, clears = 0, updates = 0, notifications = 0, ratlines = [];
    const viewBox = { x: 0, y: 0, width: 100, height: 60 };
    const viewport = {
        viewBox, svg, scale: 10,
        worldToScreen: ({ x, y }) => ({ x: (x - viewBox.x) * 10, y: (y - viewBox.y) * 10 }),
        updateViewBox: () => { updates++; }, notifyViewChanged: () => { notifications++; },
    };
    const capabilities = Object.freeze({
        requestRefresh: () => { refreshes++; },
        collectRatlines: () => ratlines,
        clearBoardSelection: () => { clears++; },
        getLayerGroup: id => id === 'drc-overlay' ? overlay : id === 'ratlines' ? rats : null,
        getViewport: () => viewport,
        ...extraCapabilities,
    });
    return {
        owner: new DrcPresentation(capabilities, dom), capabilities, dom, elements, all, panel, overlay,
        rats, container, body, viewBox,
        counts: () => ({ refreshes, clears, updates, notifications }),
        setRatlines: value => { ratlines = value; },
    };
}
const violation = (id, rule = 'short', x = 60, y = 30) => ({
    id, rule, severity: 'error', message: `Problem ${id}`, x, y, marker: { type: rule },
});
const ratline = (id, x = 0, net = 'N') => ({
    ...violation(id, 'unrouted', x + 1, 10),
    marker: { type: 'ratline', net, a: { x, y: 10 }, b: { x: x + 2, y: 10 } },
});
const result = violations => ({ violations, ok: violations.length === 0,
    counts: { errors: violations.filter(v => v.severity === 'error').length,
        warnings: violations.filter(v => v.severity !== 'error').length } });

{
    const f = fixture(), { owner, elements, panel } = f;
    owner.initialize();
    const listenerCount = f.all.reduce((sum, el) => sum + el.listenerCount(), 0);
    owner.initialize();
    assert.equal(f.all.reduce((sum, el) => sum + el.listenerCount(), 0), listenerCount,
        'initialization is idempotent and cannot double-bind shared controls');
    assert.equal(elements.pcbDrcLabel.textContent, 'Checking…');
    assert.equal(owner.shouldRun(), false);
    owner.setDesignActive(true);
    assert.equal(owner.shouldRun(), true);
    assert.equal(f.counts().refreshes, 1);
    elements.pcbDrcStatus.fire('click');
    assert.equal(panel.attributes['aria-hidden'], 'false');
    assert.equal(elements.pcbDrcStatus.attributes['aria-expanded'], 'true');
    owner.setDesignActive(false);
    assert.equal(owner.shouldRun(), true, 'the panel remains live across ribbon tab switches');
    for (const id of ['pcbClearance', 'pcbViaDiameter', 'pcbViaDrill', 'pcbRouteUnits']) elements[id].fire('change');
    assert.equal(f.counts().refreshes, 6);
    panel.fire('pointerdown');
    panel.fire('focusin');
    assert.equal(f.counts().clears, 2);
    assert.deepEqual(panel.focused, { preventScroll: true });
    assert.equal(panel.events.get('pointerdown')[0].options.capture, true);

    const short = violation('short'), clearance = violation('clearance', 'clearance');
    owner.adoptResult(result([clearance, short]));
    panel.fire('keydown', { key: 'ArrowDown' });
    assert.equal(owner.selectedId, short.id);
    assert.equal(f.overlay.children.length, 1);
    assert.equal(owner.connectorSvg.style.display, '');
    panel.fire('keydown', { key: 'ArrowDown' });
    assert.equal(owner.selectedId, clearance.id);
    const selectedRow = elements.pcbDrcList.querySelectorAll('.drc-item')[1];
    assert.deepEqual(selectedRow.focused, { preventScroll: true });
    assert.deepEqual(selectedRow.scrolled, { block: 'nearest' });
    const previous = owner.violations;
    owner.pending = true;
    owner.updateStatus(null, true);
    assert.equal(owner.violations, previous, 'pending UI keeps the last coherent list');
    assert.equal(owner.selectedId, clearance.id, 'pending UI keeps selection');
    owner.error = new Error('worker failed');
    owner.updateStatus(null, true);
    assert.equal(elements.pcbDrcLabel.textContent, 'DRC check failed');
    assert.equal(owner.violations, previous, 'errors do not replace results with a clean result');
    owner.error = null;
    owner.pending = false;
    owner.adoptResult(result([{ ...clearance, x: 70 }, short]));
    assert.equal(owner.selectedId, clearance.id, 'identity survives fresh result objects');
    assert.equal(f.overlay.firstChild.getAttribute('cx'), '70');
    owner.adoptResult(result([short]));
    assert.equal(owner.selectedId, null);
    assert.equal(f.overlay.children.length, 0);
    assert.equal(owner.connectorSvg.style.display, 'none');
    owner.adoptResult(result([{ ...short, severity: 'warning' }]));
    assert.equal(elements.pcbDrcLabel.textContent, '1 warning');
    owner.adoptResult(result([]));
    assert.equal(elements.pcbDrcLabel.textContent, 'No DRC errors');
    assert.equal(elements.pcbDrcEmpty.style.display, '');
    elements.pcbDrcSlideClose.fire('click');
    assert.equal(owner.shouldRun(), false);
    assert.equal(panel.attributes['aria-hidden'], 'true');
    owner.dispose();
}

{
    const f = fixture(), { owner, overlay, elements } = f;
    owner.initialize();
    owner.openPanel();
    f.rats.style.display = 'none';
    owner.adoptResult(result([ratline('old')]));
    owner.selectViolation('old');
    assert.deepEqual(overlay.children.map(el => el.tag), ['circle', 'line']);
    f.setRatlines([{ net: 'OTHER', x1: 0, y1: 10, x2: 2, y2: 10 },
        { net: 'N', x1: 20, y1: 10, x2: 22, y2: 10 }]);
    owner.followRatline();
    assert.equal(owner.violations[0].x, 21);
    owner.adoptResult(result([ratline('other-net', 20, 'OTHER'), ratline('far', 100), ratline('new', 20)]));
    assert.equal(owner.selectedId, 'new', 'moved coordinate identities rematch by net and nearest endpoints');
    const heading = elements.pcbDrcList.children[0];
    heading.fire('keydown', { key: 'Enter' });
    assert.equal(overlay.children.length, 0, 'collapsed group removes marker');
    owner.adoptResult(result([ratline('new', 21)]));
    owner.followRatline();
    owner.updateConnector();
    assert.equal(overlay.children.length, 0, 'fresh results and live moves cannot resurrect a collapsed marker');
    assert.equal(owner.connectorSvg.style.display, 'none');
    elements.pcbDrcList.children[0].fire('click');
    assert.equal(overlay.children.length, 2, 'expansion restores the selected hidden airwire');
    f.rats.style.display = '';
    const airwire = new Element('line');
    for (const [key, value] of Object.entries({ x1: 20, y1: 10, x2: 22, y2: 10 })) airwire.setAttribute(key, value);
    f.rats.appendChild(airwire);
    owner.overlayVisibilityChanged();
    assert.equal(overlay.children.length, 1, 'visible real airwire replaces temporary marker airwire');
    airwire.style.display = 'none';
    owner.overlayVisibilityChanged();
    assert.equal(overlay.children.length, 2, 'individually hidden airwire receives temporary highlight');

    const connector = owner.connectorSvg;
    const pendingClick = elements.pcbDrcStatus.events.get('click')[0].handler;
    const staleRow = elements.pcbDrcList.querySelectorAll('.drc-item')[0];
    const pendingRow = staleRow.events.get('click')[0].handler;
    const oldResult = owner.violations;
    owner.deactivate();
    assert.equal(owner.shouldRun(), false);
    assert.equal(overlay.children.length, 0);
    assert.equal(connector.style.display, 'none');
    const refreshes = f.counts().refreshes;
    pendingClick({ stopPropagation() {} });
    pendingRow();
    assert.equal(f.counts().refreshes, refreshes, 'deactivated event handlers cannot request checks');
    assert.equal(owner.selectedId, 'new');
    assert.equal(owner.violations, oldResult);
    owner.activate();
    assert.equal(overlay.children.length, 2);
    assert.equal(owner.connectorSvg, connector, 'activation reuses one connector');
    assert.equal(owner.shouldRun(), true);
    owner.dispose();
    owner.dispose();
    assert.equal(connector.parentElement, null);
    assert.equal(overlay.children.length, 0);
    assert.equal(elements.pcbDrcList.children.length, 0);
    assert.equal(owner.violations.length, 0);
    assert.equal(owner.selectedId, null);
    assert.equal(f.all.reduce((sum, el) => sum + el.listenerCount(), 0), 0,
        'dispose detaches every fixed and dynamically generated listener');
    pendingClick({ stopPropagation() {} });
    pendingRow();
    owner.adoptResult(result([ratline('late')]));
    owner.initialize();
    owner.activate();
    owner.openPanel();
    assert.equal(f.counts().refreshes, refreshes, 'late callbacks cannot revive disposed presentation');
    assert.equal(owner.violations.length, 0);
    assert.equal(owner.connectorSvg, null);
}

{
    const previousRequest = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
    const frames = new Map();
    let frameId = 0;
    globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    const flush = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback();
    };
    try {
        for (const rule of ['short', 'clearance']) {
            let checked = 0, live = { x: 40, y: 20 }, failure = false;
            const f = fixture({ resolvePairMarker: selected => {
                checked++;
                if (failure) throw new Error('invalid preview geometry');
                return live ? { ...selected, ...live } : null;
            } });
            const { owner, overlay } = f;
            owner.initialize();
            owner.openPanel();
            const selected = { ...violation('moving', rule),
                marker: { type: rule, pair: [{ key: 'trk:a' }, { key: 'trk:b' }] } };
            const original = structuredClone(selected);
            owner.adoptResult(result([selected]));
            owner.selectViolation(selected.id);
            const list = owner.violations, row = f.elements.pcbDrcList.children[1];
            const refreshes = f.counts().refreshes;
            for (let i = 0; i < 5; i++) owner.scheduleMarkerRefresh();
            assert.equal(frames.size, 1, 'multiple pointer updates coalesce into one geometry check');
            assert.equal(checked, 0);
            flush();
            assert.equal(checked, 1);
            assert.equal(overlay.firstChild.getAttribute('cx'), '40');
            assert.equal(overlay.firstChild.getAttribute('cy'), '20');
            assert.equal(owner.connectorSvg.style.display, '');
            const leader = owner.connectorLine.getAttribute('points');
            live = { x: 50, y: 25 };
            owner.scheduleMarkerRefresh();
            flush();
            assert.notEqual(owner.connectorLine.getAttribute('points'), leader, 'leader follows the live circle');
            assert.equal(owner.violations, list, 'live marker checks do not replace the full DRC result');
            assert.deepEqual(selected, original, 'live feedback cannot overwrite the last authoritative violation');
            assert.equal(f.elements.pcbDrcList.children[1], row, 'live checks do not rebuild the list');
            assert.equal(f.counts().refreshes, refreshes, 'live checks never request whole-board DRC');

            live = null;
            owner.scheduleMarkerRefresh();
            flush();
            assert.equal(overlay.children.length, 0, 'resolved conflict hides the ring');
            assert.equal(owner.connectorSvg.style.display, 'none', 'resolved conflict hides its leader');
            owner.updateConnector();
            owner.refreshSelectedMarker();
            assert.equal(overlay.children.length, 0, 'pan/zoom cannot resurrect an obsolete marker');
            assert.equal(owner.connectorSvg.style.display, 'none');
            assert.equal(owner.selectedId, selected.id, 'selection remains available if the conflict returns');
            live = { x: selected.x, y: selected.y };
            owner.scheduleMarkerRefresh();
            flush();
            assert.equal(overlay.firstChild.getAttribute('cx'), String(selected.x),
                'returning to the original geometry restores the marker, including cancellation');

            owner.scheduleMarkerRefresh();
            const stale = [...frames.values()][0], before = checked;
            owner.adoptResult(result([{ ...selected, x: 70, y: 40 }]));
            assert.equal(frames.size, 0);
            stale();
            assert.equal(checked, before, 'an accepted full result invalidates an earlier marker frame');
            assert.equal(overlay.firstChild.getAttribute('cx'), '70');
            owner.scheduleMarkerRefresh();
            const closed = [...frames.values()][0];
            owner.closePanel();
            closed();
            assert.equal(checked, before);
            assert.equal(overlay.children.length, 0);
            owner.openPanel();
            owner.selectViolation(selected.id);
            owner.scheduleMarkerRefresh();
            const deactivated = [...frames.values()][0];
            owner.deactivate();
            deactivated();
            assert.equal(checked, before);
            owner.activate();
            failure = true;
            const log = console.error, errors = [];
            console.error = (...args) => errors.push(args);
            try { owner.scheduleMarkerRefresh(); flush(); }
            finally { console.error = log; }
            assert.equal(errors.length, 1, 'geometry errors are explicitly reported');
            assert.equal(overlay.children.length, 0, 'failed checks do not display success-shaped feedback');
            failure = false;
            owner.scheduleMarkerRefresh();
            flush();
            assert.equal(overlay.children.length, 1, 'a subsequent valid preview can recover');
            owner.scheduleMarkerRefresh();
            const disposed = [...frames.values()][0], count = checked;
            owner.dispose();
            disposed();
            assert.equal(checked, count);
            assert.equal(frames.size, 0);
        }
    } finally {
        globalThis.requestAnimationFrame = previousRequest;
        globalThis.cancelAnimationFrame = previousCancel;
    }
}

console.log('PASS DRC presentation ownership, live pair markers, immutable results, frame coalescing and stale lifecycle cleanup');
