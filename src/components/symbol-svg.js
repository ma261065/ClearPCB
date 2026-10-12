/**
 * SVG builders for component symbols (pins and symbol graphics). Shared by the
 * schematic component renderer and the component picker previews; they read the
 * component model and return detached elements, keeping no view state.
 */

/**
 * @typedef {import('./Component.js').Component} Component
 * @typedef {import('./Component.js').ComponentSymbolGraphic} ComponentSymbolGraphic
 * @typedef {import('./Component.js').ComponentSymbolPin} ComponentSymbolPin
 */

/**
 * @param {Component} component
 * @param {number} localRot
 * @param {string} anchor
 * @returns {{ rot: number, anchor: string, flipped: boolean }}
 */
function readablePinText(component, localRot, anchor) {
        let visual = ((component.rotation + localRot) % 360 + 360) % 360;
        let flipped = false;
        if (visual > 90 && visual <= 270) {
            localRot += 180;
            flipped = true;
            if (anchor === 'start')      anchor = 'end';
            else if (anchor === 'end')   anchor = 'start';
        }
        return { rot: localRot, anchor, flipped };
}

/**
 * @param {Component} component
 * @param {ComponentSymbolPin} pin
 * @param {string} ns
 * @returns {SVGGElement}
 */
export function createSymbolPinElement(component, pin, ns) {
        const group = /** @type {SVGGElement} */ (document.createElementNS(ns, 'g'));
        const length = Number.isFinite(pin.length) ? /** @type {number} */ (pin.length) : 0;
        const source = component.symbol?._source || component.definition?._source;
        const m = component.mirror;
        const mx = (/** @type {number} */ x) => m ? -x : x;
        const flipAnchor = (/** @type {string} */ a) => a === 'start' ? 'end' : a === 'end' ? 'start' : a;
        const flipOrient = (/** @type {string} */ o) => o === 'left' ? 'right' : o === 'right' ? 'left' : o;
        const pinOrientation = pin.orientation || 'right';
        const orient = m ? flipOrient(pinOrientation) : pinOrientation;
        
        // Pin connection point
        const connectionX = mx(pin.x); 
        const connectionY = pin.y;
        
        // Line endpoints
        let x1 = mx(pin.x); 
        let y1 = pin.y;
        let x2 = x1, y2 = y1;

        // If we have path data, parse it to get the actual line coordinates
        if (pin._pathData) {
            // Try both space-separated and compact formats
            const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i) ||
                            pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
            
            if (pathMatch) {
                const startX = Number(pathMatch[1]);
                const startY = Number(pathMatch[2]);
                const cmd = pathMatch[3].toLowerCase();
                const value = Number(pathMatch[4]);
                
                x1 = mx(startX);
                y1 = startY;
                
                if (cmd === 'h') {
                    x2 = mx(startX + value);
                    y2 = startY;
                } else if (cmd === 'v') {
                    x2 = mx(startX);
                    y2 = startY + value;
                } else if (cmd === 'l') {
                    x2 = mx(startX + value);
                    y2 = startY;
                }
            }
        } else {
            // Fallback to orientation-based calculation
            switch (orient) {
                case 'right':
                    x2 = x1 + length;
                    break;
                case 'left':
                    x2 = x1 - length;
                    break;
                case 'up':
                    y2 = y1 - length;
                    break;
                case 'down':
                    y2 = y1 + length;
                    break;
            }
        }

        let nameX, nameY, nameAnchor;
        let numX, numY, numAnchor;
        let nameRot = 0;
        let numRot = 0;
        
        const isKiCad = source === 'KiCad';
        const pinName = pin.name || '';
        const isActiveLow = pin.bubble || pinName.includes('~') || pinName.includes('/');
        const bubbleRadius = 0.6;
        const dotRadius = 0.35;
        const kicadTextOffset = isKiCad ? (component.symbol?.kicadTextOffset ?? 0.508) : 0;

        const hasNamePos = pin.namePos && Number.isFinite(pin.namePos.x) && Number.isFinite(pin.namePos.y);
        const hasNumberPos = pin.numberPos && Number.isFinite(pin.numberPos.x) && Number.isFinite(pin.numberPos.y);
        const allowInfer = !(source === 'EasyEDA');

        if (hasNamePos) {
            nameX = mx(pin.namePos.x);
            nameY = pin.namePos.y;
            nameAnchor = m ? flipAnchor(pin.namePos.anchor || nameAnchor) : (pin.namePos.anchor || nameAnchor);
            if (Number.isFinite(pin.namePos.rotation)) {
                nameRot = pin.namePos.rotation;
            }
        }

        if (hasNumberPos) {
            numX = mx(pin.numberPos.x);
            numY = pin.numberPos.y;
            numAnchor = m ? flipAnchor(pin.numberPos.anchor || numAnchor) : (pin.numberPos.anchor || numAnchor);
            if (Number.isFinite(pin.numberPos.rotation)) {
                numRot = pin.numberPos.rotation;
            }
        }

        if (allowInfer && (!hasNamePos || !hasNumberPos)) {
            if (isKiCad) {
                const dx = x2 - x1;
                const dy = y2 - y1;
                const lineLen = Math.hypot(dx, dy) || 1;
                const ux = dx / lineLen;
                const uy = dy / lineLen;
                const isHorizontal = Math.abs(ux) >= Math.abs(uy);
                const numPerpOffset = Number.isFinite(pin.kicadNumberYOffset)
                    ? pin.kicadNumberYOffset
                    : -0.05;
                const perpX = -uy;
                const perpY = ux;

                if (!hasNamePos) {
                    nameX = x2 + ux * kicadTextOffset;
                    nameY = y2 + uy * kicadTextOffset;
                    if (isHorizontal) {
                        nameAnchor = ux >= 0 ? 'start' : 'end';
                    } else {
                        nameAnchor = uy >= 0 ? 'end' : 'start';
                        nameRot = -90;
                    }
                }

                if (!hasNumberPos) {
                    numX = x2 - ux * kicadTextOffset + perpX * numPerpOffset;
                    numY = y2 - uy * kicadTextOffset + perpY * numPerpOffset;
                    if (isHorizontal) {
                        numAnchor = ux >= 0 ? 'end' : 'start';
                    } else {
                        numAnchor = uy >= 0 ? 'start' : 'end';
                        numRot = -90;
                    }
                }
            } else {
            const labelOffset = length + 0.2;
            // BODY-ANCHOR LOGIC
            // We ensure the number stays close to the body/bubble so it doesn't drift into the connection dot.
            const bubbleClearance = isActiveLow ? (bubbleRadius * 2) + 0.2 : 0;
            const numBodyOffset = 0.5;
            const numPos = length - (bubbleClearance + numBodyOffset);
            
            const numOffsetLR = 0.35;
            const numOffsetUD = 0.5;
            switch (orient) {
                case 'right':
                    if (!hasNamePos) {
                        nameX = x1 + labelOffset; nameY = y1; nameAnchor = 'start';
                    }
                    if (!hasNumberPos) {
                        numX = x1 + numPos; numY = y1 - numOffsetLR; numAnchor = 'middle';
                    }
                    break;
                case 'left':
                    if (!hasNamePos) {
                        nameX = x1 - labelOffset; nameY = y1; nameAnchor = 'end';
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numPos; numY = y1 - numOffsetLR; numAnchor = 'middle';
                    }
                    break;
                case 'up':
                    if (!hasNamePos) {
                        nameX = x1; nameY = y1 - labelOffset; nameAnchor = 'end'; nameRot = 90;
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numOffsetUD; numY = y1 - numPos; numAnchor = 'middle';
                    }
                    break;
                case 'down':
                    if (!hasNamePos) {
                        nameX = x1; nameY = y1 + labelOffset; nameAnchor = 'start'; nameRot = 90;
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numOffsetUD; numY = y1 + numPos; numAnchor = 'middle';
                    }
                    break;
            }
            }
        }

        // When the component rotation makes pin text upside-down,
        // _readablePinText will add 180° to the text rotation.
        // We must also reflect the text position across the pin line
        // so it stays on the correct side visually.
        {
            const _reflectPerp = (/** @type {number} */ vis, /** @type {number} */ tX, /** @type {number} */ tY) => {
                if (vis > 90 && vis <= 270) {
                    if (orient === 'right' || orient === 'left')
                        return { x: tX, y: 2 * y1 - tY };
                    else
                        return { x: 2 * x1 - tX, y: tY };
                }
                return { x: tX, y: tY };
            };
            if (numX !== undefined && numY !== undefined) {
                const numVis = ((component.rotation + numRot) % 360 + 360) % 360;
                const rn = _reflectPerp(numVis, numX, numY);
                numX = rn.x; numY = rn.y;
            }
            if (nameX !== undefined && nameY !== undefined) {
                const nameVis = ((component.rotation + nameRot) % 360 + 360) % 360;
                const rn = _reflectPerp(nameVis, nameX, nameY);
                nameX = rn.x; nameY = rn.y;
            }
        }

        let lineX2 = x2, lineY2 = y2;
        if (isActiveLow) {
            const bOffset = bubbleRadius * 2;
            if (orient === 'right') lineX2 -= bOffset;
            else if (orient === 'left') lineX2 += bOffset;
            else if (orient === 'up') lineY2 += bOffset;
            else if (orient === 'down') lineY2 -= bOffset;
        }

        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
        line.setAttribute('x2', String(lineX2)); line.setAttribute('y2', String(lineY2));
        line.setAttribute('stroke', 'var(--sch-pin, #aa0000)');
        line.setAttribute('stroke-width', String(0.2));
        group.appendChild(line);

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', String(connectionX)); dot.setAttribute('cy', String(connectionY));
        dot.setAttribute('r', String(dotRadius));
        dot.setAttribute('fill', 'var(--sch-pin, #aa0000)'); 
        dot.setAttribute('stroke', 'none');
        dot.setAttribute('display', 'none');
        group.appendChild(dot);

        if (isActiveLow) {
            const bubble = document.createElementNS(ns, 'circle');
            let bx = x2, by = y2;
            if (orient === 'right') bx -= bubbleRadius;
            else if (orient === 'left') bx += bubbleRadius;
            else if (orient === 'up') by += bubbleRadius;
            else if (orient === 'down') by -= bubbleRadius;
            bubble.setAttribute('cx', String(bx)); bubble.setAttribute('cy', String(by));
            bubble.setAttribute('r', String(bubbleRadius));
            bubble.setAttribute('fill', 'none');
            bubble.setAttribute('stroke', 'var(--sch-pin, #aa0000)');
            bubble.setAttribute('stroke-width', String(0.254));
            group.appendChild(bubble);
        }

        const shouldShowName = pinName && pin.showName !== false && pinName !== String(pin.number);

        if (shouldShowName && (hasNamePos || allowInfer)) {
            const labelGroup = document.createElementNS(ns, 'g');
            const nameTxt = document.createElementNS(ns, 'text');
            const cleanName = pinName.replace(/[{}]/g, '').replace(/[~/]/g, '');
            const nameFontSizeBase = (pin.namePos && Number.isFinite(pin.namePos.fontSize))
                ? pin.namePos.fontSize
                : (source === 'KiCad' ? (pin.kicadNameFontSize || 1.27) : 1.0);
            const nameFontScale = source === 'KiCad' ? 1.3386 : 1.0;
            const nameFontSize = nameFontSizeBase * nameFontScale;
            const nameFontFamily = (pin.namePos && pin.namePos.fontFamily)
                ? pin.namePos.fontFamily
                : (source === 'EasyEDA' || source === 'KiCad' ? 'Verdana' : null);
            nameTxt.setAttribute('font-size', String(nameFontSize));
            if (nameFontFamily) {
                nameTxt.setAttribute('font-family', nameFontFamily);
            }
            nameTxt.setAttribute('fill', 'var(--sch-pin-name, #00cccc)');
            const nameRead = readablePinText(component, nameRot, nameAnchor || 'start');
            const effNameRot = nameRead.rot;
            const effNameAnchor = nameRead.anchor;
            if (effNameAnchor) {
                nameTxt.setAttribute('text-anchor', effNameAnchor);
            }
            nameTxt.setAttribute('dominant-baseline', 'middle');
            nameTxt.textContent = cleanName;

            if (effNameRot !== 0) {
                labelGroup.setAttribute('transform', `translate(${nameX ?? 0},${nameY ?? 0}) rotate(${effNameRot})`);
            } else {
                nameTxt.setAttribute('x', String(nameX ?? 0)); nameTxt.setAttribute('y', String(nameY ?? 0));
            }
            labelGroup.appendChild(nameTxt);

            if (isActiveLow) {
                const overbar = document.createElementNS(ns, 'line');
                const textWidth = cleanName.length * 0.65; 
                let oy = (effNameRot !== 0) ? (nameRead.flipped ? 0.8 : -0.8) : (nameY ?? 0) - 0.8;
                let ox1, ox2;
                if (effNameAnchor === 'start') {
                    ox1 = (effNameRot !== 0) ? 0.1 : (nameX ?? 0) + 0.1;
                    ox2 = ox1 + textWidth;
                } else {
                    ox2 = (effNameRot !== 0) ? -0.1 : (nameX ?? 0) - 0.1;
                    ox1 = ox2 - textWidth;
                }
                overbar.setAttribute('x1', String(ox1)); overbar.setAttribute('y1', String(oy));
                overbar.setAttribute('x2', String(ox2)); overbar.setAttribute('y2', String(oy));
                overbar.setAttribute('stroke', 'var(--sch-pin-name, #00cccc)'); overbar.setAttribute('stroke-width', String(0.15));
                labelGroup.appendChild(overbar);
            }
            group.appendChild(labelGroup);
        }

        if (pin.number && pin.showNumber !== false && (hasNumberPos || allowInfer)) {
            const numLabelGroup = document.createElementNS(ns, 'g');
            const numTxt = document.createElementNS(ns, 'text');
            const numFontSizeBase = (pin.numberPos && Number.isFinite(pin.numberPos.fontSize))
                ? pin.numberPos.fontSize
                : (source === 'KiCad' ? (pin.kicadNumberFontSize || 1.27) : 0.7);
            const numFontScale = source === 'KiCad' ? 1.3386 : 1.0;
            const numFontSize = numFontSizeBase * numFontScale;
            const numFontFamily = (pin.numberPos && pin.numberPos.fontFamily)
                ? pin.numberPos.fontFamily
                : (source === 'EasyEDA' || source === 'KiCad' ? 'Verdana' : null);
            numTxt.setAttribute('font-size', String(numFontSize));
            if (numFontFamily) {
                numTxt.setAttribute('font-family', numFontFamily);
            }
            numTxt.setAttribute('fill', 'var(--sch-pin-number, #aa0000)');
            const numRead = readablePinText(component, numRot, numAnchor || 'middle');
            const effNumRot = numRead.rot;
            const effNumAnchor = numRead.anchor;
            if (effNumAnchor) {
                numTxt.setAttribute('text-anchor', effNumAnchor);
            }
            if (source === 'KiCad') {
                numTxt.setAttribute('dominant-baseline', 'text-after-edge');
            } else {
                numTxt.setAttribute('dominant-baseline', 'middle');
            }
            numTxt.textContent = String(pin.number);
            if (effNumRot !== 0) {
                numLabelGroup.setAttribute('transform', `translate(${numX},${numY}) rotate(${effNumRot})`);
            } else {
                numTxt.setAttribute('x', String(numX)); numTxt.setAttribute('y', String(numY));
            }
            numLabelGroup.appendChild(numTxt);
            group.appendChild(numLabelGroup);
        }
        return group;
}

/**
 * @param {Component} component
 * @param {ComponentSymbolGraphic} g
 * @param {string} ns
 * @returns {SVGElement|null}
 */
export function createSymbolGraphicElement(component, g, ns) {
        /** @type {SVGElement|null} */
        let el = null;
        // Ignore colors from component data, use themed colors
        const stroke = 'var(--sch-symbol-outline, #000000)';
        const fill = 'none';
        const m = component.mirror;
        const mx = (/** @type {number} */ x) => m ? -x : x;
        switch (g.type) {
            case 'rect':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'rect'));
                el.setAttribute('x', m ? -(g.x + g.width) : g.x); el.setAttribute('y', g.y);
                el.setAttribute('width', g.width); el.setAttribute('height', g.height);
                if (Number.isFinite(g.rx)) el.setAttribute('rx', g.rx);
                if (Number.isFinite(g.ry)) el.setAttribute('ry', g.ry);
                break;
            case 'circle':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'circle'));
                el.setAttribute('cx', String(mx(g.cx))); el.setAttribute('cy', String(g.cy)); el.setAttribute('r', String(g.r));
                break;
            case 'line':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'line'));
                el.setAttribute('x1', String(mx(g.x1))); el.setAttribute('y1', String(g.y1));
                el.setAttribute('x2', String(mx(g.x2))); el.setAttribute('y2', String(g.y2));
                break;
            case 'polyline':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'polyline'));
                const pts = (g.points || []).map((/** @type {number[]} */ p) => `${mx(p[0])},${p[1]}`).join(' ');
                el.setAttribute('points', pts);
                break;
            case 'polygon':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'polygon'));
                const polPts = (g.points || []).map((/** @type {number[]} */ p) => `${mx(p[0])},${p[1]}`).join(' ');
                el.setAttribute('points', polPts);
                break;
            case 'arc': {
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'path'));
                const r = g.r || 1;
                const sa = (g.startAngle || 0) * Math.PI / 180;
                const ea = (g.endAngle || 0) * Math.PI / 180;
                const cx = mx(g.cx);
                if (m) {
                    // Mirror reflects angles: angle -> PI - angle, and swap start/end
                    const msa = Math.PI - ea;
                    const mea = Math.PI - sa;
                    const sx = cx + r * Math.cos(msa);
                    const sy = g.cy + r * Math.sin(msa);
                    const ex = cx + r * Math.cos(mea);
                    const ey = g.cy + r * Math.sin(mea);
                    let delta = mea - msa;
                    if (delta < 0) delta += 2 * Math.PI;
                    const largeArc = delta > Math.PI ? 1 : 0;
                    el.setAttribute('d', `M${sx},${sy} A${r},${r} 0 ${largeArc} 1 ${ex},${ey}`);
                } else {
                    const sx = g.cx + r * Math.cos(sa);
                    const sy = g.cy + r * Math.sin(sa);
                    const ex = g.cx + r * Math.cos(ea);
                    const ey = g.cy + r * Math.sin(ea);
                    let delta = ea - sa;
                    if (delta < 0) delta += 2 * Math.PI;
                    const largeArc = delta > Math.PI ? 1 : 0;
                    el.setAttribute('d', `M${sx},${sy} A${r},${r} 0 ${largeArc} 1 ${ex},${ey}`);
                }
                break;
            }
            case 'path':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'path'));
                if (m) {
                    // Wrap path in a group with scale(-1,1) to mirror it
                    // (parsing SVG path data to negate x is fragile)
                    const wrapper = document.createElementNS(ns, 'g');
                    wrapper.setAttribute('transform', 'scale(-1,1)');
                    el.setAttribute('d', g.d);
                    el.setAttribute('stroke', stroke); el.setAttribute('fill', fill);
                    el.setAttribute('stroke-width', String(g.strokeWidth || 0.254));
                    el.setAttribute('stroke-linecap', 'round');
                    el.setAttribute('stroke-linejoin', 'round');
                    if (g.transform) el.setAttribute('transform', g.transform);
                    wrapper.appendChild(el);
                    return /** @type {SVGElement} */ (wrapper);
                }
                el.setAttribute('d', g.d);
                break;
            case 'text': {
                const tmpl = g.text || '';
                // Skip template text — these are rendered as independent field Text shapes
                if (tmpl.includes('${REF}') || tmpl.includes('${VALUE}')) return null;
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'text'));
                el.setAttribute('x', String(mx(g.x))); el.setAttribute('y', String(g.y));
                const textSize = g.fontSize || 1.5;
                const source = component.symbol?._source || component.definition?._source;
                const textScale = source === 'KiCad' ? 1.6 : 1.0;
                el.setAttribute('font-size', String(textSize * textScale));
                if (source === 'KiCad') {
                    el.setAttribute('font-family', 'Verdana');
                }
                el.setAttribute('fill', 'var(--sch-text, #cccccc)');
                const anchor = g.anchor || 'start';
                el.setAttribute('text-anchor', m ? (anchor === 'start' ? 'end' : anchor === 'end' ? 'start' : anchor) : anchor);
                if (g.baseline) {
                    el.setAttribute('dominant-baseline', g.baseline);
                } else {
                    el.setAttribute('dominant-baseline', 'middle');
                }
                el.textContent = tmpl;
                if (g.transform) {
                    el.setAttribute('transform', g.transform);
                }
                return el;
            }
        }
        if (el) {
            el.setAttribute('stroke', stroke); el.setAttribute('fill', fill);
            el.setAttribute('stroke-width', String(g.strokeWidth || 0.254));
            el.setAttribute('stroke-linecap', 'round');
            el.setAttribute('stroke-linejoin', 'round');
            if (g.transform) {
                el.setAttribute('transform', g.transform);
            }
        }
        return el;
}
