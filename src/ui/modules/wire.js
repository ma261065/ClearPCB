import { Wire } from '../../shapes/index.js';

export function getWireSnappedPosition(app, worldPos) {
    const gridSnapped = app.viewport.getSnappedPosition(worldPos);
    const targetPin = findNearbyPin(app.components, worldPos, 1.0);

    if (app.wirePoints.length === 0) {
        return { ...gridSnapped, snapPin: null, targetPin: null };
    }

    const lastPoint = app.wirePoints[app.wirePoints.length - 1];

    if (targetPin && targetPin !== app.wireStartPin) {
        if (!(lastPoint.pin && lastPoint.pin === targetPin)) {
            return { ...targetPin.worldPos, snapPin: targetPin, targetPin: targetPin };
        }
    }

    if (app.wirePoints.length === 1) {
        const dx = Math.abs(worldPos.x - lastPoint.x);
        const dy = Math.abs(worldPos.y - lastPoint.y);

        if (app.wireDirection) {
            if (app.wireDirection === 'horizontal') {
                return { x: gridSnapped.x, y: lastPoint.y, snapPin: null };
            }
            if (app.wireDirection === 'vertical') {
                return { x: lastPoint.x, y: gridSnapped.y, snapPin: null };
            }
        }

        const minMovement = 0.05;
        if (dx > dy && dx > minMovement) {
            app.wireDirection = 'horizontal';
            return { x: gridSnapped.x, y: lastPoint.y, snapPin: null };
        }
        if (dy > dx && dy > minMovement) {
            app.wireDirection = 'vertical';
            return { x: lastPoint.x, y: gridSnapped.y, snapPin: null };
        }

        return { x: lastPoint.x, y: lastPoint.y, snapPin: null };
    }

    const dx = Math.abs(worldPos.x - lastPoint.x);
    const dy = Math.abs(worldPos.y - lastPoint.y);
    const minMovement = 0.05;

    let segmentDirection = null;
    if (dx > dy && dx > minMovement) {
        segmentDirection = 'horizontal';
    } else if (dy > dx && dy > minMovement) {
        segmentDirection = 'vertical';
    }

    if (targetPin && targetPin !== app.wireStartPin) {
        const targetX = targetPin.worldPos.x;
        const targetY = targetPin.worldPos.y;

        if (segmentDirection === 'horizontal') {
            return { x: targetX, y: lastPoint.y, snapPin: null, targetPin: targetPin };
        }
        if (segmentDirection === 'vertical') {
            return { x: lastPoint.x, y: targetY, snapPin: null, targetPin: targetPin };
        }

        const hApproach = { x: gridSnapped.x, y: targetY, distance: Math.abs(worldPos.y - targetY) };
        const vApproach = { x: targetX, y: gridSnapped.y, distance: Math.abs(worldPos.x - targetX) };

        if (hApproach.distance < vApproach.distance) {
            return { x: hApproach.x, y: hApproach.y, snapPin: null, targetPin: targetPin };
        }
        return { x: vApproach.x, y: vApproach.y, snapPin: null, targetPin: targetPin };
    }

    if (dx > dy && dx > minMovement) {
        return { x: gridSnapped.x, y: lastPoint.y, snapPin: null, targetPin: null };
    }
    if (dy > dx && dy > minMovement) {
        return { x: lastPoint.x, y: gridSnapped.y, snapPin: null, targetPin: null };
    }

    return { x: lastPoint.x, y: lastPoint.y, snapPin: null, targetPin: null };
}

export function findNearbyPin(components, worldPos, tolerance = 0.5) {
    let nearest = null;
    let minDist = tolerance;

    for (const component of components) {
        if (!component.symbol || !component.symbol.pins) continue;

        for (const pin of component.symbol.pins) {
            const pinWorldX = component.x + pin.x;
            const pinWorldY = component.y + pin.y;

            const dist = Math.hypot(worldPos.x - pinWorldX, worldPos.y - pinWorldY);

            if (dist < minDist) {
                minDist = dist;
                nearest = {
                    component,
                    pin,
                    distance: dist,
                    worldPos: { x: pinWorldX, y: pinWorldY }
                };
            }
        }
    }

    return nearest;
}

export function isSamePin(pin1, pin2) {
    return pin1?.component?.id === pin2?.component?.id &&
           pin1?.pin?.number === pin2?.pin?.number;
}

export function pointsMatch(a, b, epsilon = 1e-6) {
    return a && b && Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

export function checkAutoCornerTriggers(app, rawDx, rawDy, primaryDir, gridSize, lastWorldPos, worldPos) {
    const autoCornerDeadband = gridSize * 0.5;
    const prevCellX = Math.floor(lastWorldPos.x / gridSize);
    const prevCellY = Math.floor(lastWorldPos.y / gridSize);
    const currCellX = Math.floor(worldPos.x / gridSize);
    const currCellY = Math.floor(worldPos.y / gridSize);
    const crossedGridLineX = currCellX !== prevCellX;
    const crossedGridLineY = currCellY !== prevCellY;
    const turningHorizontalTrigger = primaryDir === 'horizontal' && (rawDy > autoCornerDeadband || crossedGridLineY);
    const turningVerticalTrigger = primaryDir === 'vertical' && (rawDx > autoCornerDeadband || crossedGridLineX);

    return {
        triggered: turningHorizontalTrigger || turningVerticalTrigger,
        turningHorizontalTrigger,
        turningVerticalTrigger
    };
}

export function startWireDrawing(app, snappedData) {
    const snapPin = snappedData.snapPin;

    if (snapPin) {
        app.wirePoints = [{ x: snappedData.x, y: snappedData.y, pin: snapPin }];
        app.wireSnapPin = snapPin;
        app.wireStartPin = snapPin;
    } else {
        app.wirePoints = [{ x: snappedData.x, y: snappedData.y }];
        app.wireSnapPin = null;
        app.wireStartPin = null;
    }

    app.wireAutoCorner = null;
    app.wireActiveAxis = null;
    app.wireLastAdjustedPoint = null;
    app.isDrawing = true;
    app._createPreview();
    app._showCrosshair();
    app._updateCrosshair(snappedData);
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

export function updateWireDrawing(app, worldPos) {
    if (!app.isDrawing || app.wirePoints.length === 0) return;

    let lastPoint = { ...app.wirePoints[app.wirePoints.length - 1] };
    const gridSize = app.viewport.gridSize || 1.0;

    let nearPin = findNearbyPin(app.components, worldPos, 2.0);

    if (nearPin && app.wireStartPin && app.wirePoints.length === 1) {
        if (isSamePin({ component: nearPin.component, pin: nearPin.pin }, app.wireStartPin)) {
            nearPin = null;
        }
    }

    if (nearPin && nearPin !== app.wireSnapPin) {
        if (app.wireSnapPin) app._unhighlightPin();
        app.wireSnapPin = nearPin;
        app._highlightPin(nearPin);
    } else if (!nearPin && app.wireSnapPin) {
        app._unhighlightPin();
    }

    const rawDx = Math.abs(worldPos.x - lastPoint.x);
    const rawDy = Math.abs(worldPos.y - lastPoint.y);
    const dist = Math.hypot(worldPos.x - lastPoint.x, worldPos.y - lastPoint.y);

    if (dist < gridSize * 0.15) {
        app.wireActiveAxis = null;
    } else if (!app.wireActiveAxis) {
        app.wireActiveAxis = rawDx >= rawDy ? 'horizontal' : 'vertical';
    }

    const gridSnapped = app.viewport.getSnappedPosition(worldPos);
    let target = { ...gridSnapped };
    let isAdjusted = false;

    if (nearPin) {
        const pinPos = nearPin.worldPos;
        const dxPin = Math.abs(worldPos.x - pinPos.x);
        const dyPin = Math.abs(worldPos.y - pinPos.y);
        const snapThreshold = 0.75;

        if (app.wireActiveAxis === 'horizontal') {
            if (dyPin < snapThreshold) target.y = pinPos.y;
            if (dxPin < snapThreshold) target.x = pinPos.x;
        } else if (app.wireActiveAxis === 'vertical') {
            if (dxPin < snapThreshold) target.x = pinPos.x;
            if (dyPin < snapThreshold) target.y = pinPos.y;
        } else if (dxPin < snapThreshold && dyPin < snapThreshold) {
            target = { ...pinPos };
        }

        if (app.wirePoints.length >= 2) {
            const lastWaypoint = app.wirePoints[app.wirePoints.length - 1];
            const prevWay = app.wirePoints[app.wirePoints.length - 2];
            if (!lastWaypoint.pin) {
                const isVerticalPrev = Math.abs(lastWaypoint.x - prevWay.x) < 0.05;
                const isHorizontalPrev = Math.abs(lastWaypoint.y - prevWay.y) < 0.05;
                const shiftThreshold = gridSize * 0.8;

                if (app.wireActiveAxis === 'horizontal') {
                    const dy = Math.abs(target.y - lastWaypoint.y);
                    if (isVerticalPrev && dy > 0.05 && dy < shiftThreshold) {
                        lastPoint.y = target.y;
                        isAdjusted = true;
                    }
                } else if (app.wireActiveAxis === 'vertical') {
                    const dx = Math.abs(target.x - lastPoint.x);
                    if (isHorizontalPrev && dx > 0.05 && dx < shiftThreshold) {
                        lastPoint.x = target.x;
                        isAdjusted = true;
                    }
                }
            }
        }
    }

    const orthogonalSnapLimit = gridSize * 0.45;
    if (!nearPin) {
        if (app.wireActiveAxis === 'vertical' && rawDx <= orthogonalSnapLimit) {
            target.x = lastPoint.x;
        } else if (app.wireActiveAxis === 'horizontal' && rawDy <= orthogonalSnapLimit) {
            target.y = lastPoint.y;
        }
    }

    app.wireAutoCorner = null;
    if (app.wireActiveAxis === 'vertical') {
        if (Math.abs(target.x - lastPoint.x) > 0.05 && Math.abs(target.y - lastPoint.y) > 0.05) {
            app.wireAutoCorner = { x: lastPoint.x, y: target.y };
        }
    } else if (app.wireActiveAxis === 'horizontal') {
        if (Math.abs(target.x - lastPoint.x) > 0.05 && Math.abs(target.y - lastPoint.y) > 0.05) {
            app.wireAutoCorner = { x: target.x, y: lastPoint.y };
        }
    }

    app.drawCurrent = target;
    app.wireLastAdjustedPoint = isAdjusted ? lastPoint : null;
    app.lastSnappedData = { x: target.x, y: target.y, snapPin: nearPin, targetPin: nearPin };
    updateWirePreview(app);
}

export function getWireAnchorSnappedPosition(app, wireShape, anchorId, worldPos) {
    const snapped = app.viewport.getSnappedPosition(worldPos);
    const match = anchorId?.match(/point(\d+)/);
    if (!match || !wireShape?.points || wireShape.points.length === 0) return snapped;

    const idx = parseInt(match[1]);
    if (Number.isNaN(idx) || idx < 0 || idx >= wireShape.points.length) return snapped;

    const original = (anchorId === app.dragAnchorId && app.dragWireAnchorOriginal)
        ? app.dragWireAnchorOriginal
        : null;

    if (!original) return snapped;

    const gridSize = app.viewport.gridSize || 1.0;
    const halfGrid = gridSize * 0.5;
    const prev = wireShape.points[idx - 1] || null;
    const next = wireShape.points[idx + 1] || null;

    let snapX = snapped.x;
    let snapY = snapped.y;

    if (prev) {
        if (Math.abs(worldPos.x - prev.x) <= halfGrid) {
            snapX = prev.x;
        }
        if (Math.abs(worldPos.y - prev.y) <= halfGrid) {
            snapY = prev.y;
        }
    }
    if (next) {
        if (Math.abs(worldPos.x - next.x) <= halfGrid) {
            snapX = next.x;
        }
        if (Math.abs(worldPos.y - next.y) <= halfGrid) {
            snapY = next.y;
        }
    }

    const useX = Math.abs(worldPos.x - original.x) <= Math.abs(worldPos.x - snapX)
        ? original.x
        : snapX;
    const useY = Math.abs(worldPos.y - original.y) <= Math.abs(worldPos.y - snapY)
        ? original.y
        : snapY;

    return { x: useX, y: useY };
}

export function addWireWaypoint(app, waypointData) {
    if (app.wirePoints.length === 0) return;

    if (app.wireLastAdjustedPoint && app.wirePoints.length > 0) {
        app.wirePoints[app.wirePoints.length - 1] = { ...app.wireLastAdjustedPoint };
        app.wireLastAdjustedPoint = null;
    }

    const sourcePoint = waypointData?.point || app.drawCurrent;
    const point = waypointData.snapPin ?
        { x: sourcePoint.x, y: sourcePoint.y, pin: waypointData.snapPin } :
        { x: sourcePoint.x, y: sourcePoint.y };

    app.wirePoints.push(point);
    app.wireAutoCorner = null;
    app.wireActiveAxis = null;
    updateWirePreview(app);
}

export function finishWireDrawing(app, worldPos) {
    if (app.wireAutoCorner) {
        const lastPoint = app.wirePoints[app.wirePoints.length - 1];
        if (!pointsMatch(lastPoint, app.wireAutoCorner)) {
            addWireWaypoint(app, { point: app.wireAutoCorner, snapPin: null });
        }
    }

    if (app.drawCurrent) {
        const lastPoint = app.wirePoints[app.wirePoints.length - 1];
        if (!pointsMatch(lastPoint, app.drawCurrent)) {
            addWireWaypoint(app, { point: app.drawCurrent, snapPin: app.lastSnappedData?.snapPin || null });
        }
    }

    if (app.wirePoints.length < 2) {
        cancelWireDrawing(app);
        return;
    }

    app._unhighlightPin();

    const wire = new Wire({
        points: app.wirePoints.map(p => ({ x: p.x, y: p.y })),
        color: '#00cc66',
        lineWidth: 0.2,
        connections: {
            start: app.wirePoints[0].pin ? {
                componentId: app.wirePoints[0].pin.component.id,
                pinNumber: app.wirePoints[0].pin.pin.number
            } : null,
            end: app.wirePoints[app.wirePoints.length - 1].pin ? {
                componentId: app.wirePoints[app.wirePoints.length - 1].pin.component.id,
                pinNumber: app.wirePoints[app.wirePoints.length - 1].pin.pin.number
            } : null
        }
    });

    app.addShape(wire);
    cancelWireDrawing(app);
}

export function cancelWireDrawing(app) {
    app.wirePoints = [];
    app.wireSnapPin = null;
    app.wireStartPin = null;
    app.wireAutoCorner = null;
    app.wireActiveAxis = null;
    app.wireLastAdjustedPoint = null;
    app.wireLastWorldPos = null;
    app.wireTurned = false;
    app._unhighlightPin();

    app.isDrawing = false;
    if (app.previewElement) {
        app.previewElement.remove();
        app.previewElement = null;
    }

    app._hideCrosshair();
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

export function updateWirePreview(app) {
    if (!app.previewElement) return;

    const strokeWidth = app._getEffectiveStrokeWidth(0.2);
    let svg = '';

    const wirePoints = app.wirePoints;

    for (let i = 0; i < wirePoints.length - 1; i++) {
        const p1 = wirePoints[i];
        let p2 = wirePoints[i + 1];

        if (i === wirePoints.length - 2 && app.wireLastAdjustedPoint) {
            p2 = app.wireLastAdjustedPoint;
        }

        svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" 
                stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    }

    for (let i = 0; i < wirePoints.length; i++) {
        let p = wirePoints[i];
        if (i === wirePoints.length - 1 && app.wireLastAdjustedPoint) {
            p = app.wireLastAdjustedPoint;
        }
        svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / app.viewport.scale}" fill="#00cc66"/>`;
    }

    if (app.drawCurrent && wirePoints.length > 0) {
        const last = app.wireLastAdjustedPoint || wirePoints[wirePoints.length - 1];
        if (app.wireAutoCorner) {
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${app.wireAutoCorner.x}" y2="${app.wireAutoCorner.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
            svg += `<line x1="${app.wireAutoCorner.x}" y1="${app.wireAutoCorner.y}" x2="${app.drawCurrent.x}" y2="${app.drawCurrent.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
        } else {
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${app.drawCurrent.x}" y2="${app.drawCurrent.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
        }
    }

    app.previewElement.innerHTML = svg;
}

export function highlightPin(app, snapPin) {
    if (!snapPin || !snapPin.pin) return;

    const pinGroup = snapPin.component.pinElements?.get(snapPin.pin.number);
    if (pinGroup) {
        const dot = pinGroup.querySelector('circle');
        if (dot) {
            if (!dot.dataset.originalFill) {
                dot.dataset.originalFill = dot.getAttribute('fill');
            }
            dot.setAttribute('fill', '#ffff00');
            dot.setAttribute('r', 0.7);
        }
    }
}

export function unhighlightPin(app) {
    if (app.wireSnapPin && app.wireSnapPin.pin) {
        const pinGroup = app.wireSnapPin.component.pinElements?.get(app.wireSnapPin.pin.number);
        if (pinGroup) {
            const dot = pinGroup.querySelector('circle');
            if (dot) {
                const originalFill = dot.dataset.originalFill || 'var(--sch-pin, #aa0000)';
                dot.setAttribute('fill', originalFill);
                dot.setAttribute('r', 0.45);
            }
        }
    }
    app.wireSnapPin = null;
}
