import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { getDrcPresentation } = await import('../src/pcb/modules/drc-state.js');

function fixture({ width = 1000, height = 600, panelWidth = 320, svgInset = 0,
    scale = 10, open = true, sliding = false, viewerWidth = 0, viewerHidden = false,
    viewerSliding = false } = {}) {
    const app = Object.create(PCBApp.prototype);
    const svgRect = { left: 120 + svgInset, top: 80, width, height };
    const panel = {
        offsetLeft: 0,
        offsetParent: { getBoundingClientRect: () => ({ left: 120, top: 80 }) },
        classList: { contains: () => open },
        getBoundingClientRect: () => ({
            left: sliding ? 120 - panelWidth : 120,
            right: sliding ? 120 : 120 + panelWidth,
            top: 80, bottom: 80 + height, width: panelWidth, height,
        }),
    };
    const viewerLeft = 120 + svgInset + width - viewerWidth;
    const viewer = viewerWidth > 0 ? {
        offsetLeft: viewerLeft - 120,
        offsetParent: viewerHidden ? null : { getBoundingClientRect: () => ({ left: 120, top: 80 }) },
        style: { display: viewerHidden ? 'none' : '' },
        getBoundingClientRect: () => ({
            left: viewerSliding ? viewerLeft + viewerWidth : viewerLeft,
            right: viewerSliding ? viewerLeft + 2 * viewerWidth : viewerLeft + viewerWidth,
            top: 80, bottom: 80 + height, width: viewerWidth, height,
        }),
    } : null;
    const viewBox = { x: -40, y: -30, width: width / scale, height: height / scale };
    let updates = 0, notifications = 0;
    const screen = point => ({
        x: (point.x - viewBox.x) / viewBox.width * width,
        y: (point.y - viewBox.y) / viewBox.height * height,
    });
    const rows = ['a', 'b'].map(id => ({
        dataset: { drcId: id }, classList: { toggle() {} }, focus() {}, scrollIntoView() {},
    }));
    globalThis.document.getElementById = id => id === 'pcbDrcSlidePanel' ? panel
        : id === 'pcbDrcList' ? { querySelectorAll: () => rows } : null;
    globalThis.document.querySelector = selector => selector === '.cpcb3d-host' ? viewer : null;
    app.viewport = {
        viewBox, svg: { getBoundingClientRect: () => svgRect },
        _updateViewBox() { updates++; }, _notifyViewChanged() { notifications++; },
    };
    const drc = getDrcPresentation(app);
    drc.drawMarker = () => {};
    drc.updateConnector = () => {};
    const covered = open ? Math.max(0, panelWidth - svgInset) : 0;
    const rightCovered = viewer && !viewerHidden ? viewerWidth : 0;
    const point = (x, y) => ({ x: viewBox.x + x / scale, y: viewBox.y + y / scale });
    return { app, drc, viewBox, covered, rightCovered, point, screen, width, height,
        updates: () => updates, notifications: () => notifications };
}

for (const options of [
    {},
    { width: 400, panelWidth: 320 },
    { width: 750, panelWidth: 260, svgInset: 24 },
    { scale: 2 },
    { scale: 50 },
    { sliding: true },
]) {
    const test = fixture(options);
    const { drc, viewBox, covered, point, screen, width, height } = test;
    const size = { width: viewBox.width, height: viewBox.height };
    const hidden = point(covered / 2, height / 2);
    drc.violations = [{ id: 'a', ...hidden }, { id: 'b', ...point(width + 100, -100) }];
    drc.selectViolation('a');
    const visible = screen(hidden);
    assert.ok(visible.x > covered && visible.x < width, 'selected issue must not remain underneath the DRC panel');
    assert.ok(Math.abs(visible.x - (covered + width) / 2) < 1e-7, 'pan centres the issue in the uncovered board area');
    assert.equal(visible.y, height / 2);
    assert.equal(viewBox.width, size.width);
    assert.equal(viewBox.height, size.height);
    assert.equal(test.updates(), 1);
    assert.equal(test.notifications(), 1);

    drc.selectViolation('a');
    assert.equal(test.updates(), 1, 'selecting an already visible issue must not pan again');
    drc.moveSelection(1);
    const next = screen(drc.violations[1]);
    assert.ok(next.x > covered && next.x < width && next.y > 0 && next.y < height,
        'keyboard navigation uses the same uncovered viewport');
    assert.equal(viewBox.width, size.width, 'keyboard navigation preserves zoom');
}

{
    const test = fixture({ open: false });
    const { drc, viewBox, point, screen, width, height } = test;
    const before = { ...viewBox };
    const visible = point(160, height / 2);
    drc.ensurePointVisible(visible.x, visible.y);
    assert.deepEqual(viewBox, before, 'a closed DRC panel does not reserve board space');
    const outside = point(-100, -100);
    drc.ensurePointVisible(outside.x, outside.y);
    assert.deepEqual(screen(outside), { x: width / 2, y: height / 2 });
}

{
    const { app, viewBox } = fixture();
    app.viewport.svg = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
    getDrcPresentation(app).ensurePointVisible(-100, -100);
    assert.ok(Object.values(viewBox).every(Number.isFinite), 'hidden canvas dimensions cannot corrupt the viewBox');
}

// The 2D/3D viewer docks on the right at a user-dragged width and overlays the canvas.
for (const options of [
    { viewerWidth: 333 },
    { viewerWidth: 150 },
    { viewerWidth: 600, open: false },
    { viewerWidth: 200, viewerSliding: true },
    { viewerWidth: 250, width: 750, svgInset: 24 },
]) {
    const test = fixture(options);
    const { drc, viewBox, covered, rightCovered, point, screen, width, height } = test;
    const visibleRight = width - rightCovered;
    const hidden = point(width - rightCovered / 2, height / 2);
    drc.violations = [{ id: 'a', ...hidden }, { id: 'b', ...point(-100, height + 100) }];
    drc.selectViolation('a');
    const visible = screen(hidden);
    assert.ok(visible.x > covered && visible.x < visibleRight,
        `selected issue must not remain underneath the ${rightCovered}px board viewer`);
    assert.ok(Math.abs(visible.x - (covered + visibleRight) / 2) < 1e-7,
        'pan centres the issue between the DRC panel and the board viewer');
    drc.selectViolation('a');
    assert.equal(test.updates(), 1, 'an issue already beside the viewer does not pan again');
    drc.moveSelection(1);
    const next = screen(drc.violations[1]);
    assert.ok(next.x > covered && next.x < visibleRight, 'keyboard navigation also avoids the viewer');
}

{
    const test = fixture({ viewerWidth: 400, viewerHidden: true, open: false });
    const { drc, viewBox, point, width, height } = test;
    const before = { ...viewBox };
    const nearRight = point(width - 100, height / 2);
    drc.ensurePointVisible(nearRight.x, nearRight.y);
    assert.deepEqual(viewBox, before, 'a closed board viewer does not reserve board space');
}

{
    const test = fixture({ panelWidth: 500, viewerWidth: 480 });
    const { drc, point, screen, width, height } = test;
    const outside = point(-200, height / 2);
    drc.ensurePointVisible(outside.x, outside.y);
    assert.equal(screen(outside).x, width / 2, 'overlays covering nearly everything fall back to the whole canvas');
}

console.log('PASS DRC issue visibility beside the panel and board viewer, keyboard navigation, zoom preservation and sliding layout');
