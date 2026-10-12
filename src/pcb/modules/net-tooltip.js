/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
const netTooltipStates = new WeakMap();

/** @param {PcbEditor} app */
function state(app) {
    let s = netTooltipStates.get(app);
    if (!s) {
        s = { tooltip: null, timer: 0 };
        netTooltipStates.set(app, s);
    }
    return s;
}

/**
 * Resolve the net name for a hovered pad/track/via hit, or '' if none.
 * @param {Pick<PcbEditor, 'netlist'>} app
 * @param {{type:string, track?:any, via?:any, pad?:any, shape?:any, componentId?:string, pinNumber?:string|number}|null} hovered
 * @returns {string}
 */
export function netNameForHover(app, hovered) {
    if (!hovered) return '';
    if (hovered.type === 'track') return hovered.track?.net || '';
    if (hovered.type === 'via') return hovered.via?.net || '';
    if (hovered.type === 'standalone-pad') return hovered.pad?.net || '';
    if (hovered.type === 'shape') return hovered.shape?.net || '';
    if (hovered.type === 'pad') {
        const key = `${hovered.componentId}|${hovered.pinNumber}`;
        for (const entry of (app.netlist || [])) {
            for (const pin of entry.pins) {
                if (`${pin.componentId}|${pin.pinNumber}` === key) return entry.net || '';
            }
        }
    }
    return '';
}

/**
 * Hide the net-name tooltip if it is showing.
 * @param {PcbEditor} app
 */
export function hideNetTooltip(app) {
    const s = state(app);
    if (s.timer) {
        clearTimeout(s.timer);
        s.timer = 0;
    }
    if (s.tooltip) s.tooltip.style.display = 'none';
}

/**
 * Show/hide a small tooltip with the net name of the hovered element.
 * Appears for any hovered pad/track/via after a short delay.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 * @param {{type:string, track?:any, via?:any}|null} hovered
 */
export function updateNetTooltip(app, e, hovered) {
    const s = state(app);
    if (!hovered) {
        hideNetTooltip(app);
        return;
    }
    const net = netNameForHover(app, hovered) || '(no net)';
    const x = e.clientX, y = e.clientY;
    // Restart the show timer on each move so it appears only after the
    // pointer settles briefly over the item.
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
        s.timer = 0;
        if (!s.tooltip) {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;'
                + 'padding:2px 6px;border-radius:3px;font:11px/1.4 monospace;'
                + 'background:rgba(20,20,28,0.92);color:#9fd0ff;'
                + 'border:1px solid rgba(120,160,220,0.5);white-space:nowrap;';
            document.body.appendChild(el);
            s.tooltip = el;
        }
        const el = s.tooltip;
        el.textContent = net;
        el.style.display = 'block';
        const pad = 14;
        const maxX = window.innerWidth - el.offsetWidth - pad;
        const maxY = window.innerHeight - el.offsetHeight - pad;
        el.style.left = `${Math.min(x + pad, Math.max(pad, maxX))}px`;
        el.style.top = `${Math.min(y + pad, Math.max(pad, maxY))}px`;
    }, 400);
}

/** @param {PcbEditor} app */
export function getNetTooltipElement(app) {
    return state(app).tooltip;
}
