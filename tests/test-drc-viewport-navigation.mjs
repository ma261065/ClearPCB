import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture({ width = 1000, height = 600, panelWidth = 320, svgInset = 0,
    scale = 10, open = true, sliding = false } = {}) {
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
    app.viewport = {
        viewBox, svg: { getBoundingClientRect: () => svgRect },
        _updateViewBox() { updates++; }, _notifyViewChanged() { notifications++; },
    };
    app._getDrcPresentation().drawMarker = () => {};
    app._getDrcPresentation().updateConnector = () => {};
    const covered = open ? Math.max(0, panelWidth - svgInset) : 0;
    const point = (x, y) => ({ x: viewBox.x + x / scale, y: viewBox.y + y / scale });
    return { app, viewBox, covered, point, screen, width, height,
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
    const { app, viewBox, covered, point, screen, width, height } = test;
    const size = { width: viewBox.width, height: viewBox.height };
    const hidden = point(covered / 2, height / 2);
    app._drcViolations = [{ id: 'a', ...hidden }, { id: 'b', ...point(width + 100, -100) }];
    app._selectDRCViolation('a');
    const visible = screen(hidden);
    assert.ok(visible.x > covered && visible.x < width, 'selected issue must not remain underneath the DRC panel');
    assert.ok(Math.abs(visible.x - (covered + width) / 2) < 1e-7, 'pan centres the issue in the uncovered board area');
    assert.equal(visible.y, height / 2);
    assert.equal(viewBox.width, size.width);
    assert.equal(viewBox.height, size.height);
    assert.equal(test.updates(), 1);
    assert.equal(test.notifications(), 1);

    app._selectDRCViolation('a');
    assert.equal(test.updates(), 1, 'selecting an already visible issue must not pan again');
    app._moveDRCSelection(1);
    const next = screen(app._drcViolations[1]);
    assert.ok(next.x > covered && next.x < width && next.y > 0 && next.y < height,
        'keyboard navigation uses the same uncovered viewport');
    assert.equal(viewBox.width, size.width, 'keyboard navigation preserves zoom');
}

{
    const test = fixture({ open: false });
    const { app, viewBox, point, screen, width, height } = test;
    const before = { ...viewBox };
    const visible = point(160, height / 2);
    app._ensurePointVisible(visible.x, visible.y);
    assert.deepEqual(viewBox, before, 'a closed DRC panel does not reserve board space');
    const outside = point(-100, -100);
    app._ensurePointVisible(outside.x, outside.y);
    assert.deepEqual(screen(outside), { x: width / 2, y: height / 2 });
}

{
    const { app, viewBox } = fixture();
    app.viewport.svg = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
    app._ensurePointVisible(-100, -100);
    assert.ok(Object.values(viewBox).every(Number.isFinite), 'hidden canvas dimensions cannot corrupt the viewBox');
}

console.log('PASS DRC issue visibility beside the panel, keyboard navigation, zoom preservation and sliding layout');
