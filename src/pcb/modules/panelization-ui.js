import { PANEL_DEFAULTS, panelSettings, buildPanelLayout } from './panelization.js';
import { PCB_LAYERS } from './layers.js';
import { createPcbText, renderPcbText } from './pcb-text.js';
import { AddTextCommand } from './text-commands.js';
import { getBoardOutline } from './board-outline.js';
import { createPanelArtworkRaster } from './panelization-raster.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';

const NS = 'http://www.w3.org/2000/svg';
const previewState = new WeakMap();
const dialogs = new WeakMap();
let previewId = 0;

function svg(tag, attributes = {}) {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

function outlinePath(contours) {
    return contours.map(points => `M${points.map(point => `${point.x},${point.y}`).join('L')}Z`).join('');
}

export function panelPreviewSupportContours(layout) {
    const scale = 1e6;
    const toPath = points => points.map(point => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) }));
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths([...layout.rails, ...layout.tabs].map(toPath), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(layout.instances.map(instance => toPath(instance.points)), ClipperLib.PolyType.ptClip, true);
    const result = [];
    clipper.Execute(ClipperLib.ClipType.ctDifference, result,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return result.map(path => path.map(point => ({ x: point.X / scale, y: point.Y / scale })));
}

export function panelPreviewOutlinePath(contours, source) {
    const tolerance = 0.00002;
    const paths = [];
    for (const contour of contours) {
        for (let index = 0; index < contour.length; index++) {
            const start = contour[index];
            const end = contour[(index + 1) % contour.length];
            const dx = end.x - start.x, dy = end.y - start.y;
            const length = Math.hypot(dx, dy);
            if (length <= tolerance) continue;
            let intervals = [[0, 1]];
            for (let edge = 0; edge < source.length && intervals.length; edge++) {
                const first = source[edge], last = source[(edge + 1) % source.length];
                const distance = point => Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length;
                if (distance(first) > tolerance || distance(last) > tolerance) continue;
                const project = point => ((point.x - start.x) * dx + (point.y - start.y) * dy) / (length * length);
                const firstPosition = project(first), lastPosition = project(last);
                const low = Math.min(firstPosition, lastPosition), high = Math.max(firstPosition, lastPosition);
                intervals = intervals.flatMap(([from, to]) => {
                    if (high <= from || low >= to) return [[from, to]];
                    const remaining = [];
                    if (low > from) remaining.push([from, low]);
                    if (high < to) remaining.push([high, to]);
                    return remaining;
                });
            }
            for (const [from, to] of intervals) {
                if ((to - from) * length <= tolerance) continue;
                paths.push(`M${start.x + dx * from},${start.y + dy * from}L${start.x + dx * to},${start.y + dy * to}`);
            }
        }
    }
    return paths.join('');
}

export function renderPanelPreview(app, settings = app.panelization) {
    const previous = previewState.get(app);
    const key = settings && app.viewport ? JSON.stringify([settings, getBoardOutline(app)]) : null;
    if (previous?.layout && previous.key === key && previous.viewport === app.viewport
        && previous.group.parentNode
        && previous.layers.length === app._layerGroups.size
        && previous.layers.every(([id, layer]) => app._layerGroups.get(id) === layer)) {
        return previous.layout;
    }
    previous?.dispose?.();
    previous?.group.remove();
    previous?.note?.remove();
    previewState.delete(app);
    if (!settings || !app.viewport) return null;
    let layout;
    try { layout = buildPanelLayout(app, settings); }
    catch (error) {
        const note = renderPcbText({ id: 'panel-error', content: `Panel invalid: ${error.message}`,
            x: 0, y: -app._boardHeight - 5, size: 1.2, rotation: 0, strokeWidth: 0.15, layer: 'top-document' });
        note.style.pointerEvents = 'none';
        app._getLayerGroup('top-document').appendChild(note);
        previewState.set(app, { group: svg('g'), note });
        return null;
    }
    const group = svg('g', { class: 'pcb-panel-preview', 'pointer-events': 'none', 'aria-hidden': 'true' });
    group.style.pointerEvents = 'none';
    const style = svg('style');
    style.textContent = '.pcb-panel-preview, .pcb-panel-preview * { pointer-events: none !important; }';
    group.appendChild(style);
    const defs = svg('defs');
    group.appendChild(defs);
    const sourceLayers = [...app._layerGroups].filter(([id]) =>
        !id.includes('document') && !id.includes('overlay') && id !== 'ratlines' && id !== 'fp-lod');
    const artworkId = `pcb-panel-artwork-${++previewId}`;
    const bounds = layout.sourceBounds;
    const image = svg('image', { id: artworkId, x: bounds.x, y: bounds.y,
        width: bounds.w, height: bounds.h, preserveAspectRatio: 'none', opacity: 0.18 });
    defs.appendChild(image);
    const holeLayer = app._layerGroups.get('hole');
    const previousHoleClip = holeLayer?.getAttribute('clip-path');
    const holeDefs = svg('defs');
    const holeClipId = `${artworkId}-holes`;
    const holeClip = svg('clipPath', { id: holeClipId, clipPathUnits: 'userSpaceOnUse' });
    holeClip.appendChild(svg('path', { d: outlinePath([bounds.points]) }));
    holeDefs.appendChild(holeClip);
    app.viewport.svg.appendChild(holeDefs);
    holeLayer?.setAttribute('clip-path', `url(#${holeClipId})`);
    const disposeRaster = createPanelArtworkRaster(app, sourceLayers, image, bounds);
    const dispose = () => {
        disposeRaster();
        if (previousHoleClip) holeLayer?.setAttribute('clip-path', previousHoleClip);
        else holeLayer?.removeAttribute('clip-path');
        holeDefs.remove();
    };
    const color = PCB_LAYERS.find(layer => layer.id === 'board-outline')?.color || '#b565d9';
    for (const instance of layout.instances.slice(1)) {
        group.appendChild(svg('use', { href: `#${artworkId}`, transform: `translate(${instance.dx},${instance.dy})` }));
    }
    group.appendChild(svg('path', { d: outlinePath(panelPreviewSupportContours(layout)),
        fill: color, 'fill-opacity': 0.12, 'fill-rule': 'evenodd', stroke: 'none' }));
    group.appendChild(svg('path', { d: panelPreviewOutlinePath(layout.contours, bounds.points),
        fill: 'none', stroke: color, 'stroke-width': 0.15 }));
    if (layout.cuts.length) group.appendChild(svg('path', {
        d: layout.cuts.map(points => `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`).join(''),
        fill: 'none', stroke: color, 'stroke-width': 0.15, 'stroke-dasharray': '1 0.5',
    }));
    for (const drill of layout.drills) group.appendChild(svg('circle', {
        cx: drill.x, cy: drill.y, r: drill.diameter / 2, fill: 'none', stroke: color, 'stroke-width': 0.1,
    }));
    for (const mark of layout.fiducials) {
        group.appendChild(svg('circle', { cx: mark.x, cy: mark.y, r: mark.maskDiameter / 2,
            fill: 'none', stroke: PCB_LAYERS.find(layer => layer.id === 'top-mask')?.color || '#59b879', 'stroke-width': 0.1 }));
        group.appendChild(svg('circle', { cx: mark.x, cy: mark.y, r: mark.diameter / 2,
            fill: PCB_LAYERS.find(layer => layer.id === 'top-copper')?.color || '#e05050' }));
    }
    const overlay = app._getLayerGroup('clearance-overlay') || app._getLayerGroup('selection-overlay');
    if (overlay?.parentNode) overlay.parentNode.insertBefore(group, overlay);
    else app.viewport.addContent(group);
    previewState.set(app, { group, layout, key, viewport: app.viewport, layers: [...app._layerGroups], dispose });
    return layout;
}

export class SetPanelizationCommand {
    constructor(app, settings) {
        this.app = app;
        this.before = app.panelization ? { ...app.panelization } : null;
        this.after = settings ? panelSettings(settings) : null;
        this.noteCommands = [];
        if (this.after && !this.before?.noteCreated) {
            const layout = buildPanelLayout(app, this.after);
            this.noteCommands = layout.note.map((content, index) => new AddTextCommand(app, createPcbText({
                content, x: layout.bounds.x,
                y: layout.bounds.y - 3 - (layout.note.length - 1 - index) * 2,
                size: 1.2, rotation: 0, strokeWidth: 0.12, layer: 'top-document',
            })));
        }
        if (this.after) this.after.noteCreated = true;
        this.description = settings ? 'Panelize board' : 'Remove panel';
    }
    execute() {
        for (const command of this.noteCommands) command.execute();
        this.apply(this.after);
    }
    undo() {
        for (const command of [...this.noteCommands].reverse()) command.undo();
        this.apply(this.before);
    }
    apply(settings) {
        this.app.panelization = settings ? { ...settings } : null;
        renderPanelPreview(this.app);
    }
}

export function updatePanelRailConstraints(form) {
    let error = '';
    for (const [axis, rails] of [
        ['horizontal', ['railTop', 'railBottom']],
        ['vertical', ['railLeft', 'railRight']],
    ]) {
        const features = form.querySelector(`input[name="${axis}PositioningHoles"]`).checked
            || form.querySelector(`input[name="${axis}Fiducials"]`).checked;
        for (const key of rails) {
            const input = form.querySelector(`input[name="${key}"]`);
            const required = features && (input.valueAsNumber > 0 || input.min === '5');
            input.min = required ? '5' : '0';
            const message = required && !(input.valueAsNumber >= 5)
                ? 'Rails with positioning holes or fiducials must be at least 5 mm wide.' : '';
            input.setCustomValidity(message);
            error ||= message;
        }
    }
    return error;
}

export function openPanelizeDialog(app) {
    if (dialogs.has(app)) return;
    const settings = app.panelization ? panelSettings(app.panelization) : { ...PANEL_DEFAULTS };
    const groups = [
        { title: 'Layout', wide: true, fields: [
            ['rows', 'Rows', 1, 20, 1], ['columns', 'Columns', 1, 20, 1],
            ['rowSpacing', 'Row spacing (mm)', 0, 100, 0.1], ['columnSpacing', 'Column spacing (mm)', 0, 100, 0.1],
        ] },
        { title: 'Horizontal edges', toggles: [
            ['horizontalPositioningHoles', 'Positioning holes', 'Two 3 mm NPTH holes per enabled rail'],
            ['horizontalFiducials', 'Fiducial marks', 'Two 1 mm copper marks with 3 mm mask openings per enabled rail, both sides'],
        ], fields: [
            ['railTop', 'Top rail (mm)', 0, 100, 0.5], ['railBottom', 'Bottom rail (mm)', 0, 100, 0.5],
            ['horizontalTabsPerEdge', 'Tabs per edge', 1, 20, 1], ['horizontalTabOffset', 'Tab offset (mm)', -100, 100, 0.1],
        ] },
        { title: 'Vertical edges', toggles: [
            ['verticalPositioningHoles', 'Positioning holes', 'Two 3 mm NPTH holes per enabled rail'],
            ['verticalFiducials', 'Fiducial marks', 'Two 1 mm copper marks with 3 mm mask openings per enabled rail, both sides'],
        ], fields: [
            ['railLeft', 'Left rail (mm)', 0, 100, 0.5], ['railRight', 'Right rail (mm)', 0, 100, 0.5],
            ['verticalTabsPerEdge', 'Tabs per edge', 1, 20, 1], ['verticalTabOffset', 'Tab offset (mm)', -100, 100, 0.1],
        ] },
        { title: 'Mouse bites', wide: true, fields: [
            ['tabWidth', 'Tab width (mm)', 0.1, 20, 0.1],
            ['holeDiameter', 'Hole diameter (mm)', 0.1, 20, 0.1], ['holePitch', 'Hole pitch (mm)', 0.1, 20, 0.1],
        ] },
    ];
    const overlay = document.createElement('div');
    overlay.className = 'app-modal-overlay panelize-overlay';
    overlay.innerHTML = `<form class="app-modal panelize" role="dialog" aria-modal="false" aria-labelledby="pcbPanelTitle"
        style="width:520px;min-width:0;max-width:calc(100vw - 32px);max-height:90vh;overflow:auto;box-sizing:border-box">
        <div class="app-modal-title" id="pcbPanelTitle" style="cursor:move;touch-action:none;user-select:none">Panelize</div>
        <label style="display:block;margin:12px 0">Separation
            <select class="app-modal-input" name="separation">
                <option value="tabs">Routed tabs with mouse bites</option><option value="vcut">V-cuts</option>
            </select>
        </label>
        <div class="panelize-groups">
            ${groups.map(group => `<fieldset class="panelize-group${group.wide ? ' panelize-group-wide' : ''}">
                <legend>${group.title}</legend>
                <div class="panelize-fields">
                ${group.fields.map(([key, label, min, max, step]) => `<label>${label}
                <input class="app-modal-input" name="${key}" type="number"
                    ${key === 'rows' || key === 'columns' || key === 'verticalTabsPerEdge' || key === 'horizontalTabsPerEdge' ? 'data-number-format="integer" inputmode="numeric"' : ''}
                    value="${settings[key]}" min="${min}" max="${max}" step="${step}" required></label>`).join('')}
                ${(group.toggles || []).map(([key, label, title]) => `<label class="panelize-toggle" title="${title}">
                    <input name="${key}" type="checkbox" ${settings[key] ? 'checked' : ''}> ${label}</label>`).join('')}
                </div>
            </fieldset>`).join('')}
        </div>
        <div data-summary style="margin-top:12px;font-size:12px" aria-live="polite"></div>
        <div data-error role="alert" style="margin-top:8px;color:var(--danger,#d84949);font-size:12px"></div>
        <div class="app-modal-actions" style="flex-wrap:wrap">
            <button type="button" class="app-modal-btn" data-remove>Remove Panel</button>
            <button type="button" class="app-modal-btn" data-cancel>Cancel</button>
            <button type="submit" class="app-modal-btn app-modal-ok" data-apply>Apply</button>
        </div>
    </form>`;
    const form = overlay.querySelector('form');
    const title = /** @type {HTMLElement} */ (form.querySelector('.app-modal-title'));
    let drag = null;
    title.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || drag) return;
        const rect = form.getBoundingClientRect();
        drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        form.style.position = 'fixed';
        form.style.left = `${rect.left}px`;
        form.style.top = `${rect.top}px`;
        title.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    title.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const maxX = Math.max(0, window.innerWidth - form.offsetWidth);
        const maxY = Math.max(0, window.innerHeight - form.offsetHeight);
        form.style.left = `${Math.max(0, Math.min(event.clientX - drag.offsetX, maxX))}px`;
        form.style.top = `${Math.max(0, Math.min(event.clientY - drag.offsetY, maxY))}px`;
    });
    const stopDrag = (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag = null;
        if (title.hasPointerCapture(event.pointerId)) title.releasePointerCapture(event.pointerId);
    };
    title.addEventListener('pointerup', stopDrag);
    title.addEventListener('pointercancel', stopDrag);
    title.addEventListener('lostpointercapture', stopDrag);
    const select = form.querySelector('select');
    select.value = settings.separation;
    const error = overlay.querySelector('[data-error]');
    const summary = overlay.querySelector('[data-summary]');
    const apply = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-apply]'));
    const remove = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-remove]'));
    remove.disabled = !app.panelization;
    const priorFocus = /** @type {HTMLElement} */ (document.activeElement);
    const read = () => Object.fromEntries([...form.querySelectorAll('input,select')].map(element => {
        const input = /** @type {HTMLInputElement} */ (element);
        return [input.name, input.type === 'checkbox' ? input.checked : input.name === 'separation' ? input.value : input.valueAsNumber];
    }));
    const refresh = () => {
        for (const key of ['verticalTabsPerEdge', 'horizontalTabsPerEdge', 'verticalTabOffset', 'horizontalTabOffset', 'tabWidth', 'holeDiameter', 'holePitch']) {
            const input = form.querySelector(`input[name="${key}"]`);
            input.disabled = select.value === 'vcut';
            if (key.endsWith('TabsPerEdge') || key.endsWith('TabOffset')) {
                input.closest('label').style.display = select.value === 'vcut' ? 'none' : '';
            }
        }
        form.querySelector('input[name="tabWidth"]').closest('fieldset').style.display = select.value === 'vcut' ? 'none' : '';
        try {
            const railError = updatePanelRailConstraints(form);
            if (railError) throw new Error(railError);
            const layout = buildPanelLayout(app, read());
            error.textContent = '';
            summary.textContent = `${layout.instances.length} boards; ${layout.bounds.w.toFixed(2)} x ${layout.bounds.h.toFixed(2)} mm`;
            apply.disabled = false;
            renderPanelPreview(app, layout.settings);
        } catch (reason) {
            error.textContent = reason.message;
            summary.textContent = '';
            apply.disabled = true;
        }
    };
    const close = () => {
        overlay.remove();
        dialogs.delete(app);
        renderPanelPreview(app);
        priorFocus?.focus();
    };
    dialogs.set(app, close);
    overlay.querySelector('[data-cancel]').addEventListener('click', close);
    remove.addEventListener('click', () => {
        app.history.execute(new SetPanelizationCommand(app, null));
        close();
    });
    form.addEventListener('input', refresh);
    select.addEventListener('change', () => {
        if (select.value === 'vcut') {
            for (const key of ['rowSpacing', 'columnSpacing']) form.querySelector(`input[name="${key}"]`).value = '2.00';
        } else {
            for (const key of ['rowSpacing', 'columnSpacing']) {
                const input = form.querySelector(`input[name="${key}"]`);
                if (Number(input.value) < 1) input.value = '2';
            }
        }
        refresh();
    });
    form.addEventListener('submit', event => {
        event.preventDefault();
        try {
            const layout = buildPanelLayout(app, read());
            app.history.execute(new SetPanelizationCommand(app, layout.settings));
            close();
            const bounds = layout.bounds;
            app.viewport.fitToBounds(bounds.x, bounds.y - 12, bounds.x + bounds.w, bounds.y + bounds.h, 5);
        } catch (reason) {
            error.textContent = reason.message;
            apply.disabled = true;
        }
    });
    overlay.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...overlay.querySelectorAll('input:not(:disabled),select,button:not(:disabled)')];
            const first = /** @type {HTMLElement} */ (focusable[0]);
            const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    document.body.appendChild(overlay);
    refresh();
    form.querySelector('input')?.focus();
}

export function resetPanelPreview(app) {
    dialogs.get(app)?.();
    renderPanelPreview(app, null);
}