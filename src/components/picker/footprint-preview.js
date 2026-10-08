/**
 * ComponentPicker footprint and 3D preview owner. Renders footprints, 3D models, and KiCad footprint choices.
 */

import { escapeHtml } from '../../core/ui-helpers.js';
import { resolveObjFromModelUrl } from '../model3d-source.js';

/** @typedef {import('../ComponentPicker.js').ComponentPicker} ComponentPicker */
/** @typedef {import('../ComponentPicker.js').PickerComponentDefinition} PickerComponentDefinition */
/** @typedef {import('../ComponentPicker.js').SymbolDefinitionLike} SymbolDefinitionLike */
/** @typedef {import('../ComponentPicker.js').FootprintBox} FootprintBox */

/**
 * Sets the footprint preview section to a status message.
 * @param {string} message - The status message to display.
 * @param {boolean} available - Whether the footprint is available.
 */
export function setFootprintPreviewStatus(/** @type {ComponentPicker} */ picker, message, available) {
    if (!picker.previewFootprint) return;
    picker.previewFootprint.style.height = '80px';
    picker.previewFootprint.style.maxHeight = '';
    picker.previewFootprint.style.overflowY = '';
    picker.previewFootprint.style.alignItems = 'center';
    picker.previewFootprint.style.justifyContent = 'center';
    picker.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${message}</div>`;
    if (picker.previewFootprintInfo) {
        picker.previewFootprintInfo.innerHTML = available
            ? '<span class="cp-preview-ok">Footprint available</span>'
            : '<span class="cp-preview-warn">Footprint unavailable</span>';
    }
}

/**
 * Sets the 3D model preview section to a status message.
 * @param {string} message - The status message to display.
 * @param {boolean} available - Whether the 3D model is available.
 */
export function set3dPreviewStatus(/** @type {ComponentPicker} */ picker, message, available) {
    if (!picker.preview3d) return;
    disposeModel3dViewer(picker);
    picker.preview3d.innerHTML = `<div class="cp-preview-placeholder">${message}</div>`;
    if (picker.preview3dInfo) {
        picker.preview3dInfo.innerHTML = available
            ? '<span class="cp-preview-ok">3D model available</span>'
            : '<span class="cp-preview-warn">3D model unavailable</span>';
    }
}

/**
 * Render a KiCad STEP model in the interactive OBJ viewer by parsing STEP
 * topology and converting it to a temporary OBJ mesh.
 * Falls back to static STEP SVG when interactive conversion fails.
 * @param {string} modelUrl
 * @param {number} selId
 * @param {string} [label='3D model']
 */
export async function renderKiCadStepPreviewInteractive(/** @type {ComponentPicker} */ picker, modelUrl, selId, label = '3D model') {
    disposeModel3dViewer(picker);
    picker.preview3d.innerHTML = '<div class="cp-preview-placeholder">Loading 3D model...</div>';
    if (picker.preview3dInfo) {
        picker.preview3dInfo.innerHTML = '<span style="color:var(--text-muted)">Rendering...</span>';
    }

    try {
        const proxyUrl = picker.library?.kicadFetcher?.corsProxy || '';
        const objText = await resolveObjFromModelUrl(modelUrl, proxyUrl);
        if (!objText) {
            throw new Error('No geometry found in model');
        }
        if (!picker.selectionRequestGate.isCurrent(selId)) return;

        const { Model3DViewer } = await import('../Model3DViewer.js');
        picker.preview3d.innerHTML = '';
        picker.preview3d.classList.add('cp-preview-3d-interactive');
        const viewer = new Model3DViewer(picker.preview3d);
        const ok = viewer.setModel(objText);
        if (!ok) {
            viewer.dispose();
            throw new Error('Unable to parse generated OBJ');
        }
        picker._model3dViewer = viewer;
        if (picker.preview3dInfo) {
            picker.preview3dInfo.innerHTML =
                `<span class="cp-preview-ok">${escapeHtml(label || '3D model')}</span>` +
                ' <span style="color:var(--text-muted)">· drag to rotate</span>';
        }
        return;
    } catch (interactiveError) {
        console.warn('Interactive KiCad STEP preview failed, using static fallback:', interactiveError);
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        disposeModel3dViewer(picker);
    }

    // Fallback: static isometric SVG preview.
    try {
        const { VRMLPreview } = await import('../VRMLPreview.js');
        const svgPreview = await VRMLPreview.fetchAndRender(modelUrl, {
            lineColor: '#444444',
            fillColor: '#666666',
            lineWidth: 0.8,
            strokeOpacity: 0.9,
            fillOpacity: 0.7,
            proxyUrl: picker.library?.kicadFetcher?.corsProxy
        });
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        picker.preview3d.innerHTML = '';
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgPreview, 'image/svg+xml');
        picker.preview3d.appendChild(svgDoc.documentElement);
        if (picker.preview3dInfo) {
            picker.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
        }
    } catch (fallbackError) {
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        console.error('3D STEP preview error:', fallbackError);
        picker.preview3d.innerHTML = '<div class="cp-preview-placeholder">3D model available (STEP)</div>';
        if (picker.preview3dInfo) {
            picker.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
        }
    }
}

/**
 * Check 3D model availability for a selected footprint and render preview.
 * @param {string} footprintName
 * @param {number} selId
 */
export async function check3dModelForFootprint(/** @type {ComponentPicker} */ picker, footprintName, selId) {
    if (!footprintName) {
        set3dPreviewStatus(picker, 'Select a footprint first', false);
        picker.selectedKiCadModel3dUrl = '';
        return;
    }
    set3dPreviewStatus(picker, 'Checking 3D model...', false);
    try {
        const availability = await picker.library.kicadFetcher.checkFootprintAvailability(footprintName);
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        if (availability.has3d) {
            picker.selectedKiCadModel3dUrl = availability.modelUrl || '';
            await renderKiCadStepPreviewInteractive(picker, /** @type {string} */ (availability.modelUrl), selId, footprintName);
        } else {
            picker.selectedKiCadModel3dUrl = '';
            set3dPreviewStatus(picker, '3D model not found', false);
        }
    } catch {
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        picker.selectedKiCadModel3dUrl = '';
        set3dPreviewStatus(picker, '3D model check failed', false);
    }
}

/**
 * Render candidate footprints (with previews) to help users choose package.
 * @param {{candidates:string[], selected:string, selId:number, onPick:(picked:string)=>void}} params
 */
export function renderKiCadFootprintChoices(/** @type {ComponentPicker} */ picker, params) {
    const { candidates, selected, selId, onPick } = params;
    if (!picker.previewFootprint) return;

    picker.previewFootprint.innerHTML = '';
    picker.previewFootprint.style.height = '120px';
    picker.previewFootprint.style.maxHeight = '';
    picker.previewFootprint.style.overflowY = '';
    picker.previewFootprint.style.alignItems = 'stretch';
    picker.previewFootprint.style.justifyContent = 'stretch';

    const wrapper = document.createElement('div');
    wrapper.style.display = 'grid';
    wrapper.style.gridTemplateRows = 'auto auto 1fr';
    wrapper.style.gap = '6px';
    wrapper.style.height = '100%';

    const label = document.createElement('div');
    label.style.fontSize = '10px';
    label.style.color = 'var(--text-secondary)';
    label.textContent = 'Choose a footprint from the dropdown';

    const select = document.createElement('select');
    select.style.width = '100%';
    select.style.fontSize = '10px';
    select.style.padding = '4px';
    select.style.background = 'var(--bg-secondary)';
    select.style.color = 'var(--text-primary)';
    select.style.border = '1px solid var(--border-color)';
    select.style.borderRadius = '3px';

    const noDefaultOption = document.createElement('option');
    noDefaultOption.value = '';
    noDefaultOption.textContent = 'No default footprint';
    select.appendChild(noDefaultOption);

    for (const fpName of candidates) {
        const option = document.createElement('option');
        option.value = fpName;
        option.textContent = formatFootprintOptionLabel(picker, fpName);
        select.appendChild(option);
    }

    const previewHost = document.createElement('div');
    previewHost.style.height = '80px';
    previewHost.style.borderRadius = '4px';
    previewHost.style.background = 'var(--bg-canvas)';
    previewHost.style.display = 'flex';
    previewHost.style.alignItems = 'center';
    previewHost.style.justifyContent = 'center';
    previewHost.style.fontSize = '10px';
    previewHost.style.color = 'var(--text-muted)';
    previewHost.textContent = 'Loading...';

    /** @type {Map<string, string>} */
    const previewCache = new Map();
    /** @param {string} fpName */
    const renderSelected = async (fpName) => {
        onPick(fpName || '');
        if (!fpName) {
            previewHost.textContent = 'Select a footprint to preview';
            return;
        }
        previewHost.textContent = 'Loading...';

        if (previewCache.has(fpName)) {
            const cachedSvg = previewCache.get(fpName) || '';
            previewHost.innerHTML = cachedSvg;
            return;
        }

        try {
            const preview = await picker.library.kicadFetcher.fetchFootprintPreview(fpName);
            if (!picker.selectionRequestGate.isCurrent(selId)) return;
            let svg = '<span>Preview unavailable</span>';
            if (preview?.shapes?.length) {
                svg = renderFootprintSVG(picker, preview.shapes, /** @type {FootprintBox|null|undefined} */ (preview.bbox)) || '<span>Preview unavailable</span>';
            }
            previewCache.set(fpName, svg);
            if (select.value === fpName) {
                previewHost.innerHTML = svg;
            }
        } catch {
            if (!picker.selectionRequestGate.isCurrent(selId)) return;
            if (select.value === fpName) {
                previewHost.textContent = 'Preview error';
            }
        }
    };

    select.value = (selected && candidates.includes(selected)) ? selected : '';
    select.addEventListener('change', () => {
        renderSelected(select.value);
    });

    wrapper.appendChild(label);
    wrapper.appendChild(select);
    wrapper.appendChild(previewHost);
    picker.previewFootprint.appendChild(wrapper);
    renderSelected(select.value);
}

/**
 * Format a user-facing dropdown label while preserving canonical value separately.
 * @param {string} fpName
 * @returns {string}
 */
export function formatFootprintOptionLabel(/** @type {ComponentPicker} */ picker, fpName) {
    const [libRaw = '', nameRaw = ''] = String(fpName).split(':');
    const lib = libRaw.trim();
    const name = nameRaw.trim();
    if (!lib || !name) return String(fpName);

    // KiCad-style: show footprint name first, library nickname second.
    return `${name} (${lib})`;
}

/**
 * Provide stable fallback footprints for common KiCad fp-filter patterns.
 * @param {string[]} filters
 * @returns {string[]}
 */
export function heuristicFootprintCandidates(/** @type {ComponentPicker} */ picker, filters) {
    const normalized = (filters || []).join(' ').toUpperCase().replace(/[^A-Z0-9]/g, '');
    /** @type {string[]} */
    const out = [];
    /** @param {string} name */
    const add = (name) => {
        if (!out.includes(name)) out.push(name);
    };

    if (normalized.includes('SOT23')) {
        add('Package_TO_SOT_SMD:SOT-23');
        add('Package_TO_SOT_SMD:SOT-23-5');
        add('Package_TO_SOT_SMD:SOT-23-6');
    }
    if (normalized.includes('SC70')) {
        add('Package_TO_SOT_SMD:SC-70-5');
        add('Package_TO_SOT_SMD:SC-70-6');
    }
    if (normalized.includes('SOIC8') || normalized.includes('SO8')) {
        add('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
    }
    if (normalized.includes('TSSOP8')) {
        add('Package_SO:TSSOP-8_3x3mm_P0.65mm');
    }
    if (normalized.includes('MSOP8')) {
        add('Package_SO:MSOP-8_3x3mm_P0.65mm');
    }
    if (normalized.includes('QFN16')) {
        add('Package_DFN_QFN:QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm');
    }
    if (normalized.includes('DIP8')) {
        add('Package_DIP:DIP-8_W7.62mm');
    }

    return out.slice(0, 10);
}

/**
 * Get symbol pin count for candidate ranking.
 * @param {SymbolDefinitionLike|null|undefined} kicadSymbol
 * @returns {number}
 */
export function getSymbolPinCount(/** @type {ComponentPicker} */ picker, kicadSymbol) {
    if (!kicadSymbol || !Array.isArray(kicadSymbol.pins)) return 0;
    // Use unique pin numbers when present to avoid duplicate-unit inflation.
    const numbers = new Set(
        kicadSymbol.pins
            .map(p => String(p?.number || '').trim())
            .filter(Boolean)
    );
    if (numbers.size > 0) return numbers.size;
    return kicadSymbol.pins.length;
}

/**
 * Estimate pin count from footprint name (e.g. SOT-23-6, SOIC-8_*).
 * @param {string} fpName
 * @returns {number}
 */
export function estimateFootprintPinCount(/** @type {ComponentPicker} */ picker, fpName) {
    const text = String(fpName || '');
    if (!text) return 0;
    const namePart = text.includes(':') ? text.split(':').slice(1).join(':') : text;
    const upper = namePart.toUpperCase();

    // SOT-23-N family: SOT-23-5 → 5, SOT-23-6 → 6, SOT-23-8 → 8
    const sot23n = upper.match(/\bSOT-23-?(\d+)/);
    if (sot23n) {
        const n = parseInt(sot23n[1], 10);
        if (n >= 2 && n <= 64) return n;
    }
    // Bare SOT-23 / SOT-23W = 3 pads
    if (/\bSOT-23(?:W)?(?:_|$)/i.test(upper)) return 3;

    // SOT-3X3 family: SOT-323→2, SOT-343→4, SOT-353→5, SOT-363→6
    const sot3x3 = upper.match(/\bSOT-3(\d)3(?:\D|$)/);
    if (sot3x3) return parseInt(sot3x3[1], 10);

    // SC-70-N: SC-70-4→4, SC-70-5→5, SC-70-6→6, SC-70-8→8
    const sc70n = upper.match(/\bSC-?70-?(\d+)/);
    if (sc70n) {
        const n = parseInt(sc70n[1], 10);
        if (n >= 2 && n <= 64) return n;
    }
    // Bare SC-70 = SOT-323 = 2 pads
    if (/\bSC-?70(?:_|$)/.test(upper)) return 2;

    // Generic -N patterns: SOIC-8, TSSOP-14, QFN-16, DIP-8, etc.
    const genericN = upper.match(/(?:SOIC|TSSOP|MSOP|QFN|DFN|DIP|SOP|SSOP|LQFP|TQFP|BGA)-?(\d+)/);
    if (genericN) {
        const n = parseInt(genericN[1], 10);
        if (n >= 2 && n <= 512) return n;
    }

    // Fallback: scan underscore segments for small numbers
    const segments = namePart.split('_').map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
        const nums = Array.from(seg.matchAll(/(\d+)/g))
            .map(m => parseInt(m[1], 10))
            .filter(n => Number.isFinite(n) && n >= 2 && n <= 64);
        if (nums.length > 0) return Math.min(...nums);
    }
    return 0;
}

/**
 * Rank candidates so pin-count-compatible packages appear first.
 * If exact matches exist, keep only exact matches.
 * @param {string[]} candidates
 * @param {number} symbolPinCount
 * @returns {string[]}
 */
export function rankFootprintCandidatesByPinCount(/** @type {ComponentPicker} */ picker, candidates, symbolPinCount, maxCount = 10) {
    const list = Array.from(new Set((candidates || []).filter(Boolean)));
    if (!symbolPinCount || list.length <= 1) return list;

    const scored = list.map((name) => {
        const pins = estimateFootprintPinCount(picker, name);
        const delta = pins > 0 ? Math.abs(pins - symbolPinCount) : 999;
        return { name, pins, delta };
    });

    const exact = scored.filter(s => s.pins === symbolPinCount);
    const others = scored.filter(s => s.pins !== symbolPinCount);
    const base = exact.length > 0 ? [...exact, ...others] : scored;

    // Keep all filter-matching candidates, but prioritize exact pin-count
    // matches and cap to a practical list length for follow-up validation.
    return base
        .sort((a, b) => a.delta - b.delta || a.name.localeCompare(b.name))
        .map(s => s.name)
        .slice(0, Math.max(1, maxCount));
}

/**
 * Keep deterministic pin-compatible candidates for the dropdown.
 * Preview availability is checked lazily in the single preview pane
 * so transient fetch errors don't remove otherwise valid options.
 * @param {string[]} candidates
 * @param {number} symbolPinCount
 * @param {number} selId
 * @param {number} [maxKeep=12]
 * @returns {Promise<string[]>}
 */
export async function filterPreviewablePinCompatibleCandidates(/** @type {ComponentPicker} */ picker, candidates, symbolPinCount, selId, maxKeep = 20) {
    if (symbolPinCount <= 0) return (candidates || []).slice(0, maxKeep);

    const kept = [];
    for (const fpName of candidates || []) {
        if (!picker.selectionRequestGate.isCurrent(selId)) return kept;

        // Quick name-based pre-filter to skip obvious mismatches
        const estPins = estimateFootprintPinCount(picker, fpName);
        if (estPins > 0 && estPins !== symbolPinCount) continue;

        // Verify with actual pad count from footprint preview
        try {
            const preview = await picker.library.kicadFetcher.fetchFootprintPreview(fpName);
            const shapes = Array.isArray(preview?.shapes) ? preview.shapes : [];
            const numberedPads = new Set();
            let totalPads = 0;
            for (const shape of shapes) {
                if (typeof shape !== 'string' || !shape.startsWith('PAD~')) continue;
                totalPads += 1;
                const parts = shape.split('~');
                const padNumber = (parts[6] || '').trim();
                if (padNumber) numberedPads.add(padNumber);
            }
            const padCount = numberedPads.size > 0 ? numberedPads.size : totalPads;
            // Strict equality like KiCad: unique pad count must equal symbol pin count
            if (padCount > 0 && padCount !== symbolPinCount) continue;
            // padCount === 0 means no pad data — name estimation already passed
        } catch {
            // Preview fetch failed — name estimation already passed, keep candidate
        }

        kept.push(fpName);
        if (kept.length >= maxKeep) break;
    }
    return kept;
}

/**
 * Updates the footprint preview panel with rendered SVG from component metadata.
 * @param {PickerComponentDefinition|import('../ComponentPicker.js').EasyEDADetail|null|undefined} metadata - Component metadata containing footprint shapes and bounding box.
 */
export function updateFootprintPreview(/** @type {ComponentPicker} */ picker, metadata) {
    if (!metadata || !metadata.hasFootprint) {
        setFootprintPreviewStatus(picker, 'No footprint data', false);
        return;
    }

    picker.previewFootprint.style.height = '80px';
    picker.previewFootprint.style.maxHeight = '';
    picker.previewFootprint.style.overflowY = '';
    picker.previewFootprint.style.alignItems = 'center';
    picker.previewFootprint.style.justifyContent = 'center';

    const name = metadata.footprintName || metadata.package || 'Footprint';
    const svg = renderFootprintSVG(picker, metadata.footprintShapes, metadata.footprintBBox);
    if (!svg) {
        picker.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${escapeHtml(name)}</div>`;
        if (picker.previewFootprintInfo) {
            picker.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">Footprint available</span>';
        }
        return;
    }

    picker.previewFootprint.innerHTML = svg;
    if (picker.previewFootprintInfo) {
        picker.previewFootprintInfo.innerHTML = `<span class="cp-preview-ok">${escapeHtml(name)}</span>`;
    }
}

/**
 * Updates the 3D model preview panel by rendering VRML or OBJ model data.
 * @param {PickerComponentDefinition|import('../ComponentPicker.js').EasyEDADetail|null|undefined} metadata - Component metadata containing 3D model URL or OBJ data.
 * @returns {Promise<void>}
 */
export async function update3dPreview(/** @type {ComponentPicker} */ picker, metadata) {
    disposeModel3dViewer(picker);
    const version = picker._model3dPreviewVersion;
    if (!metadata || !metadata.has3d) {
        set3dPreviewStatus(picker, 'No 3D model', false);
        return;
    }

    const modelName = metadata.model3dName || '3D model';

    // EasyEDA OBJ models are rendered with the interactive THREE.js viewer
    // (drag to spin, wheel to zoom) — the same pipeline as the board viewer.
    if (metadata.model3dObj) {
        picker.preview3d.innerHTML = '<div class="cp-preview-placeholder">Loading 3D model...</div>';
        if (picker.preview3dInfo) {
            picker.preview3dInfo.innerHTML = '<span style="color:var(--text-muted)">Rendering...</span>';
        }
        try {
            const { Model3DViewer } = await import('../Model3DViewer.js');
            if (version !== picker._model3dPreviewVersion) return;
            picker.preview3d.innerHTML = '';
            picker.preview3d.classList.add('cp-preview-3d-interactive');
            const viewer = new Model3DViewer(picker.preview3d);
            const ok = viewer.setModel(metadata.model3dObj);
            if (!ok) {
                viewer.dispose();
                throw new Error('Unable to parse OBJ model');
            }
            picker._model3dViewer = viewer;
            if (picker.preview3dInfo) {
                picker.preview3dInfo.innerHTML =
                    `<span class="cp-preview-ok">${escapeHtml(modelName)}</span>` +
                    ' <span style="color:var(--text-muted)">· drag to rotate</span>';
            }
        } catch (error) {
            if (version !== picker._model3dPreviewVersion) return;
            console.error('Error rendering 3D preview:', error);
            disposeModel3dViewer(picker);
            picker.preview3d.innerHTML = `<div class="cp-preview-placeholder">🧊 ${escapeHtml(modelName)}</div>`;
            if (picker.preview3dInfo) {
                picker.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
            }
        }
    } else if (metadata.model3dUrl) {
        // KiCad VRML model — render as a static isometric SVG preview.
        picker.preview3d.innerHTML = '<div class="cp-preview-placeholder">Loading 3D model...</div>';
        if (picker.preview3dInfo) {
            picker.preview3dInfo.innerHTML = '<span style="color:var(--text-muted)">Rendering...</span>';
        }
        try {
            const { VRMLPreview } = await import('../VRMLPreview.js');
            if (version !== picker._model3dPreviewVersion) return;
            const svgPreview = await VRMLPreview.fetchAndRender(metadata.model3dUrl, {
                lineColor: '#444444',
                fillColor: '#666666',
                lineWidth: 0.8,
                strokeOpacity: 0.9,
                fillOpacity: 0.7,
                proxyUrl: picker.library?.kicadFetcher?.corsProxy
            });
            if (version !== picker._model3dPreviewVersion) return;
            picker.preview3d.innerHTML = '';
            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(svgPreview, 'image/svg+xml');
            picker.preview3d.appendChild(svgDoc.documentElement);
            if (picker.preview3dInfo) {
                picker.preview3dInfo.innerHTML = `<span class="cp-preview-ok">${escapeHtml(modelName)}</span>`;
            }
        } catch (error) {
            if (version !== picker._model3dPreviewVersion) return;
            console.error('Error rendering 3D preview:', error);
            picker.preview3d.innerHTML = `<div class="cp-preview-placeholder">🧊 ${escapeHtml(modelName)}</div>`;
            if (picker.preview3dInfo) {
                picker.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
            }
        }
    } else {
        // No model data available
        picker.preview3d.innerHTML = `<div class="cp-preview-placeholder">🧊 ${escapeHtml(modelName)}</div>`;
        if (picker.preview3dInfo) {
            picker.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
        }
    }
}

/** Tear down the interactive 3D viewer (frees its WebGL context). */

export function disposeModel3dViewer(/** @type {ComponentPicker} */ picker) {
    picker._model3dPreviewVersion = (picker._model3dPreviewVersion || 0) + 1;
    if (picker._model3dViewer) {
        try { picker._model3dViewer.dispose(); } catch { /* already gone */ }
        picker._model3dViewer = null;
    }
    picker.preview3d?.classList.remove('cp-preview-3d-interactive');
}

/**
 * Renders footprint pad shapes into an SVG string.
 * @param {string[]|null|undefined} shapes - Array of shape descriptor strings (e.g., PAD~ format).
 * @param {FootprintBox|null|undefined} bbox - Bounding box with x, y, width, height properties.
 * @returns {string} SVG markup string, or empty string if no valid shapes.
 */
export function renderFootprintSVG(/** @type {ComponentPicker} */ picker, shapes, bbox) {
    if (!Array.isArray(shapes) || shapes.length === 0) return '';

    const padding = 2;
    let viewBox = '-5 -5 10 10';
    if (bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.width) && Number.isFinite(bbox.height)) {
        viewBox = `${bbox.x - padding} ${bbox.y - padding} ${bbox.width + padding * 2} ${bbox.height + padding * 2}`;
    }

    let svg = `<svg viewBox="${viewBox}" style="width:100%;height:100%;max-height:100px">`;
    if (bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.width) && Number.isFinite(bbox.height)) {
        svg += `<rect x="${bbox.x}" y="${bbox.y}" width="${bbox.width}" height="${bbox.height}" fill="none" stroke="var(--text-muted)" stroke-width="0.3"/>`;
    }

    for (const shape of shapes) {
        if (typeof shape !== 'string') continue;
        if (!shape.startsWith('PAD~')) continue;

        const parts = shape.split('~');
        const padType = parts[1];
        const x = parseFloat(parts[2]);
        const y = parseFloat(parts[3]);
        const w = parseFloat(parts[4]);
        const h = parseFloat(parts[5]);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;

        if (padType === 'RECT') {
            const rx = x - w / 2;
            const ry = y - h / 2;
            svg += `<rect x="${rx}" y="${ry}" width="${w}" height="${h}" fill="var(--accent-color)" fill-opacity="0.2" stroke="var(--accent-color)" stroke-width="0.2"/>`;
        } else if (padType === 'ELLIPSE') {
            svg += `<ellipse cx="${x}" cy="${y}" rx="${w / 2}" ry="${h / 2}" fill="var(--accent-color)" fill-opacity="0.2" stroke="var(--accent-color)" stroke-width="0.2"/>`;
        }
    }

    svg += '</svg>';
    return svg;
}
