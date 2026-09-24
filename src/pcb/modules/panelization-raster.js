import { inlineSvgComputedStyles } from '../../ui/modules/export.js';

const NS = 'http://www.w3.org/2000/svg';

export function panelRasterSize(bounds, scale, pixelRatio = 1) {
    const longest = Math.max(bounds.w, bounds.h);
    const requested = longest * Math.max(0.01, scale || 1) * Math.min(2, pixelRatio || 1);
    const pixels = Math.min(2048, Math.max(256, 2 ** Math.ceil(Math.log2(requested))));
    return { width: Math.max(1, Math.ceil(bounds.w / longest * pixels)),
        height: Math.max(1, Math.ceil(bounds.h / longest * pixels)) };
}

export function createPanelArtworkRaster(app, sourceLayers, target, bounds) {
    const viewport = app.viewport;
    let disposed = false;
    let revision = 0;
    let timer = null;
    let busy = false;
    let bitmapUrl = null;
    const size = () => panelRasterSize(bounds, viewport.scale, globalThis.devicePixelRatio);
    let requestedSize = size();
    let lastScale = viewport.scale;
    const refresh = async () => {
        timer = null;
        if (disposed || busy) return;
        busy = true;
        const ticket = revision;
        let sourceUrl = null;
        try {
            const dimensions = size();
            requestedSize = dimensions;
            const root = document.createElementNS(NS, 'svg');
            root.setAttribute('width', String(dimensions.width));
            root.setAttribute('height', String(dimensions.height));
            root.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
            for (const child of viewport.svg?.children || []) {
                if (child.localName === 'defs') root.appendChild(child.cloneNode(true));
            }
            const defs = document.createElementNS(NS, 'defs');
            const clip = document.createElementNS(NS, 'clipPath');
            const clipId = `${target.id}-clip`;
            clip.id = clipId;
            clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', `M${bounds.points.map(point => `${point.x},${point.y}`).join('L')}Z`);
            clip.appendChild(path);
            defs.appendChild(clip);
            root.appendChild(defs);
            const artwork = document.createElementNS(NS, 'g');
            artwork.setAttribute('clip-path', `url(#${clipId})`);
            for (const [, layer] of sourceLayers) {
                const clone = layer.cloneNode(true);
                inlineSvgComputedStyles(layer, clone);
                artwork.appendChild(clone);
            }
            root.appendChild(artwork);
            sourceUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
            const image = new Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('Unable to render panel artwork.'));
                image.src = sourceUrl;
            });
            if (disposed || ticket !== revision) return;
            const canvas = document.createElement('canvas');
            canvas.width = dimensions.width;
            canvas.height = dimensions.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Panel preview requires a 2D canvas.');
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (disposed || ticket !== revision) return;
            if (!blob) throw new Error('Unable to encode panel preview.');
            const nextUrl = URL.createObjectURL(blob);
            target.setAttribute('href', nextUrl);
            if (bitmapUrl) URL.revokeObjectURL(bitmapUrl);
            bitmapUrl = nextUrl;
        } catch (error) {
            if (!disposed && ticket === revision) console.warn('Panel preview refresh failed:', error);
        } finally {
            if (sourceUrl) URL.revokeObjectURL(sourceUrl);
            busy = false;
            if (!disposed && ticket !== revision && timer === null) timer = setTimeout(refresh, 120);
        }
    };
    const schedule = () => {
        revision++;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(refresh, 120);
    };
    const observer = new MutationObserver(records => {
        const withoutCulling = value => (value || '').split(/\s+/).filter(name => name && name !== 'culled').sort().join(' ');
        if (records.every(record => record.type === 'attributes' && record.attributeName === 'class'
            && withoutCulling(record.oldValue) === withoutCulling(record.target.getAttribute('class')))) return;
        schedule();
    });
    for (const [, layer] of sourceLayers) {
        observer.observe(layer, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
    }
    const observedDefs = new Set();
    const observeDefinitions = () => {
        let added = false;
        for (const child of viewport.svg?.children || []) {
            if (child.localName !== 'defs' || observedDefs.has(child)) continue;
            observedDefs.add(child);
            observer.observe(child, { subtree: true, childList: true, attributes: true, characterData: true });
            added = true;
        }
        return added;
    };
    observeDefinitions();
    const viewObserver = new MutationObserver(() => {
        const definitionsAdded = observeDefinitions();
        const next = size();
        const scaleChanged = lastScale !== viewport.scale;
        lastScale = viewport.scale;
        if (!definitionsAdded && next.width === requestedSize.width && next.height === requestedSize.height
            && !(scaleChanged && (timer !== null || busy))) return;
        requestedSize = next;
        schedule();
    });
    if (viewport.svg) viewObserver.observe(viewport.svg, { childList: true, attributes: true, attributeFilter: ['viewBox'] });
    const themeObserver = new MutationObserver(schedule);
    if (document.documentElement) themeObserver.observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    schedule();
    return () => {
        disposed = true;
        observer.disconnect();
        viewObserver.disconnect();
        themeObserver.disconnect();
        if (timer !== null) clearTimeout(timer);
        if (bitmapUrl) URL.revokeObjectURL(bitmapUrl);
    };
}