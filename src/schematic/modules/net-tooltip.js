/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */

const netTooltipStates = new WeakMap();

/** @param {SchematicEditor} app */
function state(app) {
    let s = netTooltipStates.get(app);
    if (!s) {
        s = { tooltip: null, timer: 0 };
        netTooltipStates.set(app, s);
    }
    return s;
}

/**
 * @param {{type?: string, net?: string}|null} hovered
 * @returns {string|null}
 */
export function schematicNetNameForHover(hovered) {
    return hovered?.type === 'wire' ? hovered.net || '' : null;
}

/** @param {SchematicEditor} app */
export function hideSchematicNetTooltip(app) {
    const s = state(app);
    if (s.timer) {
        clearTimeout(s.timer);
        s.timer = 0;
    }
    if (s.tooltip) s.tooltip.style.display = 'none';
}

/**
 * Show the hovered wire's net name after the pointer settles briefly.
 * @param {SchematicEditor} app
 * @param {{clientX: number, clientY: number}|null|undefined} event
 * @param {{type?: string, net?: string}|null} hovered
 */
export function updateSchematicNetTooltip(app, event, hovered) {
    const net = schematicNetNameForHover(hovered);
    if (!event || net == null) {
        hideSchematicNetTooltip(app);
        return;
    }

    const s = state(app);
    if (s.timer) clearTimeout(s.timer);
    const x = event.clientX;
    const y = event.clientY;
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
        el.textContent = net || '(no net)';
        el.style.display = 'block';
        const pad = 14;
        const maxX = window.innerWidth - el.offsetWidth - pad;
        const maxY = window.innerHeight - el.offsetHeight - pad;
        el.style.left = `${Math.min(x + pad, Math.max(pad, maxX))}px`;
        el.style.top = `${Math.min(y + pad, Math.max(pad, maxY))}px`;
    }, 400);
}

/** @param {SchematicEditor} app */
export function getSchematicNetTooltipElement(app) {
    return state(app).tooltip;
}
