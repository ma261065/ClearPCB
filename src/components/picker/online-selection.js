/**
 * ComponentPicker online catalog selection owner. Loads EasyEDA/KiCad details and prepares placeable definitions.
 */

import { escapeHtml } from '../../core/ui-helpers.js';
import { check3dModelForFootprint, filterPreviewablePinCompatibleCandidates, getSymbolPinCount, heuristicFootprintCandidates, rankFootprintCandidatesByPinCount, renderFootprintSVG, renderKiCadFootprintChoices, renderKiCadStepPreviewInteractive, set3dPreviewStatus, setFootprintPreviewStatus, update3dPreview, updateFootprintPreview } from './footprint-preview.js';
import { beginPlacement } from './placement.js';
import { createMiniPreview, tryApplyLCSCThumbnail, updateLCSCPreviewImage, updatePackageSelector, updatePreview } from './symbol-preview.js';
import { setPlaceBtnLoading, setPreviewLoading } from './ui-state.js';

/** @typedef {import('../ComponentPicker.js').ComponentPicker} ComponentPicker */
/** @typedef {import('../ComponentPicker.js').ComponentProperties} ComponentProperties */
/** @typedef {import('../ComponentPicker.js').KiCadDefinition} KiCadDefinition */
/** @typedef {import('../ComponentPicker.js').KiCadSearchResult} KiCadSearchResult */
/** @typedef {import('../ComponentPicker.js').LCSCSearchResult} LCSCSearchResult */
/** @typedef {import('../ComponentPicker.js').PickerComponentDefinition} PickerComponentDefinition */
/** @typedef {import('../ComponentPicker.js').SymbolDefinitionLike} SymbolDefinitionLike */

/**
 * Handles selection of a KiCad search result and loads its preview.
 * @param {KiCadSearchResult} result - The selected KiCad result object.
 * @param {HTMLElement} itemEl - The clicked DOM element.
 */
export function selectKiCadResult(/** @type {ComponentPicker} */ picker, result, itemEl) {
    updatePackageSelector(picker, null);
    picker.listEl.querySelectorAll('.cp-item').forEach(el => el.classList.remove('selected'));
    itemEl.classList.add('selected');
    
    picker.selectedKiCadResult = result;
    picker.selectedKiCadFootprint = '';
    picker.selectedKiCadModel3dUrl = '';
    picker.selectedKiCadItem = itemEl;
    picker.selectedComponent = null;
    picker.selectedLCSCResult = null;
    
    picker.previewSvg.innerHTML = `
        <div style="text-align:center;padding:20px">
            <span style="font-size:48px">📐</span>
        </div>
    `;
    
    picker.previewInfo.innerHTML = `
        <strong>${result.name}</strong>
        <br><span style="color:var(--text-muted)">Library: ${result.library}</span>
        <br><span style="color:var(--schematic-component)">KiCad Symbol</span>
    `;

    if (picker.previewImage) {
        picker.previewImage.innerHTML = '';
    }

    picker.previewSvg.innerHTML = '<div class="cp-preview-placeholder">Loading symbol...</div>';
    setFootprintPreviewStatus(picker, 'Checking KiCad footprint...', false);
    set3dPreviewStatus(picker, 'Checking 3D model...', false);

    picker.placeBtn.disabled = true;
    setPlaceBtnLoading(picker, 'Checking footprint...', true);
    setPreviewLoading(picker, 'Loading component...');
    picker.placeBtn.onclick = null;

            loadKiCadFootprintStatus(picker, result);
}

/**
 * Loads and verifies KiCad footprint and 3D model availability for a selected result.
 * @param {KiCadSearchResult} result - The KiCad result to check footprint status for.
 * @returns {Promise<void>}
 */
export async function loadKiCadFootprintStatus(/** @type {ComponentPicker} */ picker, result) {
    const selId = picker.selectionRequestGate.next();
    try {
        const kicadDefinition = await picker.searchManager.fetchFromKiCad(result.library, result.name);
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        const kicadSymbol = kicadDefinition?.symbol || kicadDefinition;
        const kicadProperties = kicadDefinition?.properties || kicadDefinition?.symbol?.properties || kicadSymbol?.properties;
        const footprintName = getPropertyValue(picker, kicadProperties, 'Footprint');
        const footprintFilters = getFootprintFilters(picker, kicadProperties);

        if (kicadSymbol) {
            /** @type {PickerComponentDefinition} */
            const previewDef = kicadDefinition?.symbol
                ? kicadDefinition
                : {
                    name: `KiCad_${result.name}`,
                    description: `${result.name} from KiCad ${result.library} library`,
                    category: 'KiCad',
                    symbol: kicadSymbol
                };
            if (kicadSymbol?._kicadRaw) {
                previewDef._kicadRaw = kicadSymbol._kicadRaw;
            }

            updatePreview(picker, previewDef, { skipFootprint3d: true });

            if (picker.selectedKiCadItem) {
                const iconEl = picker.selectedKiCadItem.querySelector('.cp-item-icon');
                if (iconEl) {
                    iconEl.innerHTML = await createMiniPreview(picker, previewDef);
                }
            }

            const hasRenderable = (kicadSymbol?.pins?.length || 0) > 0 || (kicadSymbol?.graphics?.length || 0) > 0;
            if (!hasRenderable) {
                picker.previewSvg.innerHTML = '<div class="cp-preview-placeholder">No KiCad symbol graphics available</div>';
            }
        }

        if (!footprintName) {
            if (footprintFilters.length > 0) {
                setFootprintPreviewStatus(picker, 'Searching footprint options...', false);
                let candidates = await picker.library.kicadFetcher.findFootprintCandidatesByFilters(footprintFilters, { limit: 500 });
                if (candidates.length === 0) {
                    candidates = heuristicFootprintCandidates(picker, footprintFilters);
                }
                const symbolPinCount = getSymbolPinCount(picker, kicadSymbol);
                candidates = await filterPreviewablePinCompatibleCandidates(picker, candidates, symbolPinCount, selId, 20);
                if (candidates.length === 0) {
                    // Last resort to avoid blank chooser.
                    candidates = rankFootprintCandidatesByPinCount(picker, 
                        await picker.library.kicadFetcher.findFootprintCandidatesByFilters(footprintFilters, { limit: 120 }),
                        symbolPinCount,
                        10
                    );
                }
                if (!picker.selectionRequestGate.isCurrent(selId)) return;

                const hasRenderable = (kicadSymbol?.pins?.length || 0) > 0 || (kicadSymbol?.graphics?.length || 0) > 0;
                const placeDefNoFp = buildKiCadDefinition(picker, kicadDefinition, result);

                if (candidates.length > 0) {
                    renderKiCadFootprintChoices(picker, {
                        candidates,
                        selected: picker.selectedKiCadFootprint || candidates[0],
                        selId,
                        onPick: (picked) => {
                            picker.selectedKiCadFootprint = picked;
                            setPlaceBtnLoading(picker, 'Place Component', false);
                            if (!picked) {
                                picker.placeBtn.disabled = true;
                                picker.placeBtn.textContent = 'Place Component';
                                picker.placeBtn.onclick = null;
                                set3dPreviewStatus(picker, 'Select a footprint first', false);
                            } else {
                                picker.placeBtn.disabled = !hasRenderable;
                                picker.placeBtn.textContent = 'Place Component';
                                if (hasRenderable) {
                                    picker.placeBtn.onclick = () => {
                                        const def = buildKiCadDefinition(picker, kicadDefinition, result);
                                        def.footprint = picked;
                                        def.footprintName = picked;
                                        def.hasFootprint = true;
                                        if (picker.selectedKiCadFootprint === picked && picker.selectedKiCadModel3dUrl) {
                                            def.has3d = true;
                                            def.model3dUrl = picker.selectedKiCadModel3dUrl;
                                            def.model3dName = picked;
                                        }
                                        beginPlacement(picker, def, { skipFootprint3d: true });
                                    };
                                } else {
                                    picker.placeBtn.onclick = null;
                                }
                                check3dModelForFootprint(picker, picked, selId);
                            }
                        }
                    });

                    if (picker.previewFootprintInfo) {
                        picker.previewFootprintInfo.innerHTML = '';
                    }
                    set3dPreviewStatus(picker, 'Select a footprint first', false);
                    setPreviewLoading(picker, null);
                    return;
                }

                const filterLabel = footprintFilters.slice(0, 3).join(', ');
                const suffix = footprintFilters.length > 3 ? ' ...' : '';
                setFootprintPreviewStatus(picker, `Footprint filters: ${filterLabel}${suffix}`, true);
                if (picker.previewFootprintInfo) {
                    picker.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">No concrete match found automatically</span>';
                }

                set3dPreviewStatus(picker, '3D model not verified', false);
                picker.placeBtn.disabled = !hasRenderable;
                picker.placeBtn.textContent = hasRenderable ? 'Place Symbol Only' : 'No symbol data';
                picker.placeBtn.onclick = hasRenderable
                    ? () => beginPlacement(picker, placeDefNoFp, { skipFootprint3d: true })
                    : null;
                setPreviewLoading(picker, null);
                return;
            } else {
                setFootprintPreviewStatus(picker, 'Footprint not specified', false);
            }
            set3dPreviewStatus(picker, '3D model not verified', false);
            // Allow placement even without a footprint — it's a schematic symbol
            const placeDefNoFp = buildKiCadDefinition(picker, kicadDefinition, result);
            const hasRenderable = (kicadSymbol?.pins?.length || 0) > 0 || (kicadSymbol?.graphics?.length || 0) > 0;
            picker.placeBtn.disabled = !hasRenderable;
            picker.placeBtn.textContent = hasRenderable ? 'Place Component' : 'No symbol data';
            if (hasRenderable) {
                picker.placeBtn.onclick = () => beginPlacement(picker, placeDefNoFp, { skipFootprint3d: true });
            }
            return;
        }

        const availability = await picker.library.kicadFetcher.checkFootprintAvailability(footprintName);
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        /** @type {string[]|null} */
        let fetchedFpShapes = null;
        /** @type {import('../ComponentPicker.js').FootprintBox|null} */
        let fetchedFpBBox = null;
        if (availability.hasFootprint) {
            const preview = await picker.library.kicadFetcher.fetchFootprintPreview(footprintName);
            if (preview?.shapes && preview.shapes.length > 0) {
                fetchedFpShapes = preview.shapes;
                fetchedFpBBox = /** @type {import('../ComponentPicker.js').FootprintBox|null} */ (preview.bbox);
                const svg = renderFootprintSVG(picker, preview.shapes, /** @type {import('../ComponentPicker.js').FootprintBox|null|undefined} */ (preview.bbox));
                if (svg) {
                    picker.previewFootprint.innerHTML = svg;
                    picker.previewFootprintInfo.innerHTML = `<span class="cp-preview-ok">${escapeHtml(footprintName)}</span>`;
                } else {
                    picker.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${escapeHtml(footprintName)}</div>`;
                    picker.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">Footprint available</span>';
                }
            } else {
                picker.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${escapeHtml(footprintName)}</div>`;
                picker.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">Footprint available</span>';
            }
        } else {
            setFootprintPreviewStatus(picker, 'Footprint not found', false);
        }

        if (availability.has3d) {
            await renderKiCadStepPreviewInteractive(picker, /** @type {string} */ (availability.modelUrl), selId, footprintName);
        } else {
            set3dPreviewStatus(picker, '3D model not found', false);
        }

        const ready = availability.hasFootprint;
        const placeDefinition = buildKiCadDefinition(picker, kicadDefinition, result);
        if (fetchedFpShapes) {
            placeDefinition.footprintShapes = fetchedFpShapes;
            placeDefinition.footprintBBox = fetchedFpBBox;
        }
        if (availability.has3d && availability.modelUrl) {
            placeDefinition.has3d = true;
            placeDefinition.model3dUrl = availability.modelUrl;
            placeDefinition.model3dName = footprintName;
        }
        picker.placeBtn.disabled = !ready;
        picker.placeBtn.textContent = ready ? 'Place Component' : 'Missing footprint';
        picker.placeBtn.onclick = ready
            ? () => beginPlacement(picker, placeDefinition, { skipFootprint3d: true })
            : null;
        setPreviewLoading(picker, null);
    } catch (error) {
        console.error('Failed to verify KiCad footprint:', error);
        setFootprintPreviewStatus(picker, 'Footprint check failed', false);
        set3dPreviewStatus(picker, '3D check failed', false);
        setPreviewLoading(picker, null);
        // Still allow placement if we have symbol data
        if (picker.selectedKiCadResult) {
            picker.placeBtn.disabled = false;
            picker.placeBtn.textContent = 'Place Component';
            const fallbackResult = picker.selectedKiCadResult;
            picker.placeBtn.onclick = () => fetchAndPlaceKiCad(picker, fallbackResult);
        } else {
            picker.placeBtn.disabled = true;
            picker.placeBtn.textContent = 'Check failed';
        }
    }
}

/**
 * Fetches full KiCad symbol data and initiates component placement.
 * @param {KiCadSearchResult} result - The KiCad result to fetch and place.
 * @returns {Promise<void>}
 */
export async function fetchAndPlaceKiCad(/** @type {ComponentPicker} */ picker, result) {
    picker.placeBtn.disabled = true;
    setPlaceBtnLoading(picker, 'Fetching...', true);
    
    try {
        // Use SearchManager to fetch from KiCad
        const kicadData = await picker.searchManager.fetchFromKiCad(result.library, result.name);
        const kicadSymbol = kicadData?.symbol || kicadData;
        const kicadProperties = kicadData?.properties || kicadData?.symbol?.properties || kicadSymbol?.properties;
        
        if (kicadData) {
            const footprintName = getPropertyValue(picker, kicadProperties, 'Footprint');
            let availability = null;
            if (footprintName) {
                availability = await picker.library.kicadFetcher.checkFootprintAvailability(footprintName);
                if (!availability.hasFootprint) {
                    picker.previewInfo.innerHTML += `<br><span style="color:var(--text-muted)">Footprint not found on KiCad GitLab</span>`;
                }
            }

            // Create a component definition from KiCad data
            const definition = buildKiCadDefinition(picker, kicadData, result);

            // Fetch real footprint pad geometry so the PCB editor can render it
            if (footprintName && !definition.footprintShapes) {
                try {
                    const fpPreview = await picker.library.kicadFetcher.fetchFootprintPreview(footprintName);
                    if (fpPreview?.shapes?.length) {
                        definition.footprintShapes = fpPreview.shapes;
                        definition.footprintBBox = /** @type {import('../ComponentPicker.js').FootprintBox|null|undefined} */ (fpPreview.bbox);
                    }
                } catch (_) { /* non-fatal */ }
            }
            if (availability?.has3d && availability.modelUrl) {
                definition.has3d = true;
                definition.model3dUrl = availability.modelUrl;
                definition.model3dName = footprintName || 'KiCad STEP model';
            }
            
            picker.library.addDefinition(definition, 'KiCad');
            beginPlacement(picker, definition, { skipFootprint3d: true });
            
            if (definition.symbol) {
                updatePreview(picker, definition);
            }
        }
    } catch (error) {
        console.error('Failed to fetch KiCad symbol:', error);
        picker.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${escapeHtml(error.message)}</span>`;
    } finally {
        picker.placeBtn.disabled = false;
        picker.placeBtn.textContent = 'Place Component';
    }
}

/**
 * Handles selection of an LCSC/EasyEDA search result and loads its preview.
 * @param {LCSCSearchResult} result - The selected LCSC result object.
 * @param {HTMLElement} itemEl - The clicked DOM element.
 * @returns {Promise<void>}
 */
export async function selectLCSCResult(/** @type {ComponentPicker} */ picker, result, itemEl) {
    updatePackageSelector(picker, null);
    picker.listEl.querySelectorAll('.cp-item').forEach(el => el.classList.remove('selected'));
    itemEl.classList.add('selected');
    
    picker.selectedLCSCResult = result;
    picker.selectedComponent = null;
    
    picker.previewSvg.innerHTML = `
        <div class="cp-lcsc-preview-placeholder">
            <span style="font-size:48px">📦</span>
        </div>
    `;
    
    // Build info display
    let info = `<strong>${result.mpn || result.lcscPartNumber}</strong>`;
    if (result.lcscPartNumber) info += `<br><span style="color:var(--text-secondary)">${result.lcscPartNumber}</span>`;
    if (result.manufacturer) info += `<br><span style="color:var(--text-muted)">${result.manufacturer}</span>`;
    if (result.description) info += `<br><span style="color:var(--text-muted);font-size:10px">${result.description.substring(0, 100)}${result.description.length > 100 ? '...' : ''}</span>`;
    if (result.package) info += `<br><span style="color:var(--text-muted)">Package: ${result.package}</span>`;
    
    // Price breaks
    if (result.price != null) {
        info += `<br><span style="color:var(--schematic-component)">$${result.price.toFixed(4)}/pc</span>`;
    }
    
    // Stock
    const stock = result.stock || 0;
    if (stock > 0) {
        info += `<br><span style="color:var(--text-muted)">${stock.toLocaleString()} in stock</span>`;
    } else {
        info += `<br><span style="color:var(--accent-color)">Out of stock</span>`;
    }
    
    // Basic/Extended status
    if (result.isBasic) {
        info += `<br><span class="cp-badge cp-badge-basic">Basic Part</span>`;
    }
    
    picker.previewInfo.innerHTML = info;

    updateLCSCPreviewImage(picker, result);
    
    setFootprintPreviewStatus(picker, 'Loading footprint...', false);
    set3dPreviewStatus(picker, 'Loading 3D data...', false);

    picker.placeBtn.disabled = true;
    setPlaceBtnLoading(picker, 'Preparing...', true);
    setPreviewLoading(picker, 'Loading component...');
    picker.placeBtn.onclick = null;

    await loadEasyEDADetailForPreview(picker, result);
}

/**
 * Loads EasyEDA component detail metadata and updates footprint/3D previews.
 * @param {LCSCSearchResult} result - The LCSC result to load detail for.
 * @returns {Promise<void>}
 */
export async function loadEasyEDADetailForPreview(/** @type {ComponentPicker} */ picker, result) {
    const selId = picker.selectionRequestGate.next();
    try {
        if (!result || !result.lcscPartNumber) {
            setFootprintPreviewStatus(picker, 'No footprint data', false);
            set3dPreviewStatus(picker, 'No 3D model', false);
            picker.placeBtn.disabled = true;
            picker.placeBtn.textContent = 'Missing footprint/3D';
            picker.placeBtn.onclick = null;
            return;
        }

        if (!result._detailPromise) {
            result._detailPromise = picker.library.lcscFetcher.fetchComponentMetadata(result.lcscPartNumber);
        }

        const metadata = await result._detailPromise;
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        if (!metadata) {
            setFootprintPreviewStatus(picker, 'No footprint data', false);
            set3dPreviewStatus(picker, 'No 3D model', false);
            picker.placeBtn.disabled = true;
            picker.placeBtn.textContent = 'Missing footprint/3D';
            picker.placeBtn.onclick = null;
            return;
        }

        result._detail = metadata;
        result._detailPromise = null;

        updateFootprintPreview(picker, metadata);
        update3dPreview(picker, metadata);

        const ready = metadata.hasFootprint;
        if (!ready) {
            picker.placeBtn.disabled = true;
            picker.placeBtn.textContent = 'Missing footprint';
            picker.placeBtn.onclick = null;
            return;
        }

        if (!result._definitionPromise) {
            result._definitionPromise = picker.searchManager.fetchFromLCSC(result.lcscPartNumber);
        }

        const definition = await result._definitionPromise;
        if (!picker.selectionRequestGate.isCurrent(selId)) return;
        if (definition?.symbol) {
            updatePreview(picker, definition);
            if (picker.selectedLCSCResult === result) {
                const selectedItem = picker.listEl.querySelector('.cp-item.selected');
                if (selectedItem) {
                    const iconEl = selectedItem.querySelector('.cp-item-icon');
                    if (iconEl) {
                        // Try to show photo first, fall back to rendered symbol
                        const hasPhoto = await tryApplyLCSCThumbnail(picker, /** @type {HTMLElement} */ (iconEl), result);
                        if (!hasPhoto) {
                            iconEl.innerHTML = await createMiniPreview(picker, definition);
                        }
                    }
                }
            }
        }

        picker.placeBtn.disabled = false;
        picker.placeBtn.textContent = 'Place Component';
        picker.placeBtn.onclick = () => placePrefetchedLCSC(picker, result);
        setPreviewLoading(picker, null);
    } catch (error) {
        console.error('Failed to load EasyEDA detail:', error);
        setFootprintPreviewStatus(picker, 'Footprint load failed', false);
        set3dPreviewStatus(picker, '3D load failed', false);
        setPreviewLoading(picker, null);
        picker.placeBtn.disabled = true;
        picker.placeBtn.textContent = 'Missing footprint/3D';
        picker.placeBtn.onclick = null;
    }
}

/**
 * Fetches full EasyEDA/LCSC component data and initiates placement.
 * @param {LCSCSearchResult} result - The LCSC result to fetch and place.
 * @returns {Promise<void>}
 */
export async function fetchAndPlace(/** @type {ComponentPicker} */ picker, result) {
    picker.placeBtn.disabled = true;
    setPlaceBtnLoading(picker, 'Placing...', true);

    let fetchedDefinition = null;
    
    try {
        if (result?._detailPromise) {
            await result._detailPromise;
        }

        // Use SearchManager to fetch from LCSC
        const definition = result?._definitionPromise
            ? await result._definitionPromise
            : await picker.searchManager.fetchFromLCSC(/** @type {string} */ (result.lcscPartNumber));
        
        if (definition) {
            fetchedDefinition = definition;

            const detail = result?._detail;
            if (detail) {
                definition.footprintName = definition.footprintName || detail.footprintName || detail.package || '';
                definition.footprintShapes = definition.footprintShapes || detail.footprintShapes || null;
                definition.footprintBBox = definition.footprintBBox || detail.footprintBBox || null;
                definition.model3dName = definition.model3dName || detail.model3dName || '';
                definition.hasFootprint = definition.hasFootprint || !!detail.hasFootprint || !!(detail.footprintShapes && detail.footprintShapes.length > 0);
                definition.has3d = definition.has3d || !!detail.has3d || !!detail.model3dName;
            }

            if (!definition.hasFootprint) {
                picker.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint data</span>`;
                updatePreview(picker, definition);
                picker.placeBtn.disabled = true;
                picker.placeBtn.textContent = 'Missing footprint';
                picker.placeBtn.onclick = null;
                return;
            }

            beginPlacement(picker, definition);
        }
    } catch (error) {
        console.error('Failed to fetch component:', error);
        picker.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${escapeHtml(error.message)}</span>`;
    } finally {
        if (!fetchedDefinition) {
            picker.placeBtn.disabled = false;
            picker.placeBtn.textContent = 'Place Component';
        }
    }
}

/**
 * Places a component using prefetched LCSC data, including footprint and 3D metadata.
 * @param {LCSCSearchResult} result - The LCSC result with prefetched definition data.
 * @returns {Promise<void>}
 */
export async function placePrefetchedLCSC(/** @type {ComponentPicker} */ picker, result) {
    picker.placeBtn.disabled = true;
    setPlaceBtnLoading(picker, 'Placing...', true);

    try {
        if (result?._detailPromise) {
            await result._detailPromise;
        }

        if (!result?._definitionPromise) {
            result._definitionPromise = picker.searchManager.fetchFromLCSC(/** @type {string} */ (result.lcscPartNumber));
        }

        const definition = await result._definitionPromise;
        if (definition) {
            const detail = result?._detail;
            if (detail) {
                definition.footprintName = definition.footprintName || detail.footprintName || detail.package || '';
                definition.footprintShapes = definition.footprintShapes || detail.footprintShapes || null;
                definition.footprintBBox = definition.footprintBBox || detail.footprintBBox || null;
                definition.model3dName = definition.model3dName || detail.model3dName || '';
                definition.hasFootprint = definition.hasFootprint || !!detail.hasFootprint || !!(detail.footprintShapes && detail.footprintShapes.length > 0);
                definition.has3d = definition.has3d || !!detail.has3d || !!detail.model3dName;
            }

            if (!definition.hasFootprint) {
                picker.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint data</span>`;
                updatePreview(picker, definition);
                picker.placeBtn.disabled = true;
                picker.placeBtn.textContent = 'Missing footprint';
                picker.placeBtn.onclick = null;
                return;
            }

            beginPlacement(picker, definition);
        }
    } catch (error) {
        console.error('Failed to place component:', error);
        picker.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${escapeHtml(error.message)}</span>`;
        picker.placeBtn.disabled = false;
        picker.placeBtn.textContent = 'Place Component';
    }
}

/**
 * Builds a normalized component definition from raw KiCad data.
 * @param {KiCadDefinition|null|undefined} kicadData - Raw KiCad symbol data (may contain nested symbol property).
 * @param {KiCadSearchResult} result - The KiCad search result with name and library info.
 * @returns {PickerComponentDefinition} A component definition suitable for placement.
 */
export function buildKiCadDefinition(/** @type {ComponentPicker} */ picker, kicadData, result) {
    const kicadSymbol = kicadData?.symbol || kicadData;
    const kicadProperties = kicadData?.properties || kicadData?.symbol?.properties || kicadSymbol?.properties;
    const footprintName = getPropertyValue(picker, kicadProperties, 'Footprint');
    const footprintFilters = getFootprintFilters(picker, kicadProperties);
    const def = kicadData?.symbol
        ? { ...kicadData, _source: 'KiCad' }
        : {
            name: `KiCad_${result.name}`,
            description: `${result.name} from KiCad ${result.library} library`,
            category: 'KiCad',
            symbol: kicadSymbol,
            _source: 'KiCad'
        };
    def.defaultValue = getPropertyValue(picker, kicadProperties, 'Value') || result.name;
    if (footprintName) {
        def.footprint = footprintName;
        def.footprintName = footprintName;
    }
    if (footprintFilters.length > 0) {
        def.footprintFilters = footprintFilters;
        if (!def.footprintName) {
            def.footprintName = footprintFilters[0];
        }
    }
    def.hasFootprint = !!(footprintName || footprintFilters.length > 0);
    def.model3dObj = def.model3dObj || null;
    def.model3dUrl = def.model3dUrl || null;
    def.has3d = !!(def.has3d || def.model3dObj || def.model3dUrl);
    if (kicadSymbol?._kicadRaw) def._kicadRaw = kicadSymbol._kicadRaw;
    return def;
}

/**
 * Retrieves a property value from a properties object using case-insensitive key matching.
 * @param {ComponentProperties|null|undefined} properties - The properties object to search.
 * @param {string} key - The property key to look up.
 * @returns {string} The property value, or empty string if not found.
 */
export function getPropertyValue(/** @type {ComponentPicker} */ picker, properties, key) {
    if (!properties || typeof properties !== 'object') return '';
    if (properties[key]) return String(properties[key]);

    const lowerKey = key.toLowerCase();
    const match = Object.keys(properties).find(propKey => propKey.toLowerCase() === lowerKey);
    return match ? String(properties[match] ?? '') : '';
}

/**
 * Returns normalized KiCad footprint filter tokens (ki_fp_filters).
 * @param {ComponentProperties|null|undefined} properties
 * @returns {string[]}
 */
export function getFootprintFilters(/** @type {ComponentPicker} */ picker, properties) {
    const raw = getPropertyValue(picker, properties, 'ki_fp_filters');
    if (!raw) return [];
    const tokens = String(raw).split(/\s+/).map(s => s.trim()).filter(Boolean);
    return Array.from(new Set(tokens));
}
