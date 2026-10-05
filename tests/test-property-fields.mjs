import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { renderPropertyFields, renderPropertyActions, MIXED_LABEL } = await import('../src/shared/ui/property-fields.js');
const { flushSettledChanges } = await import('../src/shared/ui/settled-input.js');

const fire = (control, type, extra = {}) => control.dispatchEvent({
    type, preventDefault() {}, stopPropagation() {}, ...extra,
});
const panel = () => document.body.appendChild(document.createElement('div'));

// Number: live preview on input/change, one commit once the run settles.
{
    const container = panel();
    const calls = [];
    const field = {
        key: 'size', type: 'number', label: 'Size (mm)', id: 'size', value: 1.5, min: 0.05, step: 0.05,
        preview: value => calls.push(['preview', value]),
        commit: value => calls.push(['commit', value]),
        cancel: () => { calls.push(['cancel']); return true; },
    };
    const input = renderPropertyFields(container, [field]).get('size');
    const [row] = container.children;
    assert.equal(row.dataset.prop, 'size');
    assert.equal(row.className, 'prop-row');
    assert.equal(input.value, '1.5');
    assert.equal(input.getAttribute('min'), '0.05');
    for (const value of ['1.55', '1.6']) {
        input.value = value;
        fire(input, 'input');
        fire(input, 'change');
    }
    assert.deepEqual(calls.filter(([kind]) => kind === 'commit'), [], 'Spinner steps do not commit');
    assert.deepEqual(calls.at(-1), ['preview', 1.6], 'Each step previews');
    flushSettledChanges();
    assert.deepEqual(calls.filter(([kind]) => kind === 'commit'), [['commit', 1.6]], 'The settled run commits once');

    calls.length = 0;
    input.value = '2';
    fire(input, 'input');
    fire(input, 'keydown', { key: 'Enter' });
    assert.deepEqual(calls, [['preview', 2], ['commit', 2]], 'Enter commits at once');

    calls.length = 0;
    input.value = '2.5';
    fire(input, 'input');
    input.value = '';
    fire(input, 'input');
    assert.deepEqual(calls, [['preview', 2.5], ['cancel']],
        'An invalid entry cancels the live preview at once, so no owner can commit a stale value');
    fire(input, 'change');
    flushSettledChanges();
    assert.ok(!calls.some(([kind]) => kind === 'commit'), 'nothing commits');
    assert.equal(input.value, '1.5', 'and the field shows the described value again');

    calls.length = 0;
    input.value = 'abc';
    fire(input, 'change');
    flushSettledChanges();
    assert.deepEqual(calls, [['cancel']], 'An unparsable value cancels');
    assert.equal(input.value, '1.5', 'and restores the described value');

    calls.length = 0;
    input.value = '3';
    fire(input, 'input');
    fire(input, 'keydown', { key: 'Escape' });
    assert.deepEqual(calls, [['preview', 3], ['cancel']], 'Escape cancels the preview');
    assert.equal(input.value, '1.5');
}

// One commit per edit: blur without an edit commits nothing; settling, Enter and blur never double up.
{
    const container = panel();
    const commits = [];
    const input = renderPropertyFields(container, [{
        key: 'width', type: 'number', label: 'Width (mm)', value: 1, commit: value => commits.push(value),
    }]).get('width');
    fire(input, 'blur');
    flushSettledChanges();
    assert.deepEqual(commits, [], 'leaving an unedited field commits nothing');
    input.value = '2';
    fire(input, 'input');
    fire(input, 'change');
    fire(input, 'blur');
    await null;
    flushSettledChanges();
    assert.deepEqual(commits, [2], 'an edit left by blur commits once');
    input.value = '3';
    fire(input, 'input');
    fire(input, 'keydown', { key: 'Enter' });
    fire(input, 'change');
    flushSettledChanges();
    assert.deepEqual(commits, [2, 3], 'Enter and the change that follows it commit once');
}

// Re-describing reconciles rows by key: focused edits survive, limits and hooks update.
{
    const container = panel();
    const seen = [];
    const describe = (size, drillMax) => [
        { key: 'size', type: 'number', label: 'Size (mm)', value: size, commit: value => seen.push(['size', value]) },
        { key: 'drill', type: 'number', label: 'Drill (mm)', value: 0.4, max: drillMax, commit: value => seen.push(['drill', value]) },
    ];
    const first = renderPropertyFields(container, describe(1, 1));
    const size = first.get('size');
    document.activeElement = size;
    size.value = '2';
    fire(size, 'input');
    const second = renderPropertyFields(container, describe(1.2, 2));
    assert.equal(second.get('size'), size, 'the row is reused');
    assert.equal(size.value, '2', 'a focused field keeps the value being edited');
    assert.equal(second.get('drill').getAttribute('max'), '2', 'limits follow the new description');
    renderPropertyFields(container, describe(1.2, 2).map(field => ({ ...field, commit: value => seen.push(['new', field.key, value]) })));
    fire(size, 'keydown', { key: 'Enter' });
    assert.deepEqual(seen, [['new', 'size', 2]], 'events use the latest description');
    renderPropertyFields(container, describe(2, 2));
    assert.equal(size.value, '2');
    document.activeElement = null;
    renderPropertyFields(container, describe(3, 3));
    assert.equal(size.value, '3', 'an unfocused field shows the described value');
    renderPropertyFields(container, describe(3, 3).slice(1));
    assert.deepEqual(container.children.map(row => row.dataset.prop), ['drill'], 'undescribed rows go');
    renderPropertyFields(container, [], { placeholder: 'Nothing to edit' });
    assert.equal(container.children[0].textContent, 'Nothing to edit');
    assert.throws(() => renderPropertyFields(container, [...describe(1, 1), ...describe(1, 1)]), /Duplicate property field: size/);
}

// Mixed values and disabled fields look the same in every panel.
{
    const container = panel();
    const commits = [];
    const controls = renderPropertyFields(container, [
        { key: 'locked', type: 'checkbox', label: 'Locked', mixed: true, commit: value => commits.push(['locked', value]) },
        { key: 'layer', type: 'select', label: 'Layer', mixed: true,
            options: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom', disabled: true, dataset: { pcbLayerLabel: 'Bottom' } }],
            commit: value => commits.push(['layer', value]) },
        { key: 'drill', type: 'number', label: 'Drill (mm)', mixed: true, disabled: true },
        { key: 'name', type: 'text', label: 'Name', mixed: true },
        { key: 'x', type: 'readout', label: 'X (mm)', value: '1.00' },
    ]);
    const [lockedRow] = container.children;
    assert.equal(lockedRow.tagName, 'label');
    assert.equal(lockedRow.className, 'prop-row prop-toggle');
    const locked = controls.get('locked');
    assert.equal(locked.indeterminate, true);
    assert.equal(locked.checked, false);
    locked.checked = true;
    fire(locked, 'change');
    const layer = controls.get('layer');
    const [mixedOption, , bottom] = layer.children;
    assert.equal(mixedOption.textContent, MIXED_LABEL);
    assert.equal(mixedOption.disabled, true);
    assert.equal(bottom.disabled, true);
    assert.equal(bottom.dataset.pcbLayerLabel, 'Bottom');
    layer.value = 'top';
    fire(layer, 'change');
    assert.deepEqual(commits, [['locked', true], ['layer', 'top']], 'Checkbox and select commit on change');
    const drill = controls.get('drill');
    assert.equal(drill.value, '');
    assert.equal(drill.placeholder, MIXED_LABEL);
    assert.equal(drill.disabled, true);
    assert.equal(controls.get('name').placeholder, MIXED_LABEL);
    assert.equal(controls.get('x').textContent, '1.00');
    assert.deepEqual(container.children.map(row => row.dataset.prop), ['locked', 'layer', 'x', 'drill', 'name'],
        'rows follow the canonical property order; unranked keys go last');
}

// A field-level error uses native validity and title without panel-specific DOM code.
{
    const container = panel();
    const input = renderPropertyFields(container, [
        { key: 'width', type: 'number', label: 'Width (mm)', id: 'width', value: 0.2 },
    ]).get('width');
    assert.equal(input.validationMessage, '');
    renderPropertyFields(container, [
        { key: 'width', type: 'number', label: 'Width (mm)', id: 'width', value: 0.2, title: 'Track width',
            error: 'Enter a positive finite number.' },
    ]);
    assert.equal(input.validationMessage, 'Enter a positive finite number.');
    assert.equal(input.getAttribute('title'), 'Enter a positive finite number.');
    assert.equal(input.reports, 1);
    renderPropertyFields(container, [
        { key: 'width', type: 'number', label: 'Width (mm)', id: 'width', value: 0.2, title: 'Track width' },
    ]);
    assert.equal(input.validationMessage, '');
    assert.equal(input.getAttribute('title'), 'Track width');
}

// Mixed number fields can seed native spinner/Arrow-key stepping from a panel-provided value.
{
    const container = panel();
    const calls = [];
    const controls = renderPropertyFields(container, [
        { key: 'width', type: 'number', label: 'Width', mixed: true, format: value => Number(value).toFixed(2),
            formatStepped: true, seedMixed: () => 0.2, preview: value => calls.push(['preview', value]) },
    ]);
    const width = controls.get('width');
    assert.equal(width.value, '');
    fire(width, 'keydown', { key: 'ArrowUp' });
    assert.equal(width.value, '0.20', 'Arrow stepping seeds an empty mixed field');
    width.value = '0.25';
    fire(width, 'input');
    assert.equal(width.value, '0.25', 'stepped values keep the field format');
    assert.deepEqual(calls, [['preview', 0.25]]);
    fire(width, 'keyup', { key: 'ArrowUp' });

    width.value = '';
    fire(width, 'pointerdown', { button: 0, pointerId: 1 });
    assert.equal(width.value, '0.20', 'spinner pointer stepping also seeds mixed fields');
}

// Net: a typed net or a menu choice commits; a disabled net has no menu.
{
    const container = panel();
    const commits = [];
    const controls = renderPropertyFields(container, [
        { key: 'net', type: 'net', label: 'Net', id: 'net', value: 'GND', nets: ['GND', 'VCC'], commit: value => commits.push(value) },
        { key: 'other', prop: 'net', type: 'net', label: 'Net', value: '', placeholder: 'Auto', disabled: true },
    ]);
    const [netRow, otherRow] = container.children;
    const buttons = netRow.querySelector('details').querySelectorAll('button');
    assert.deepEqual(buttons.map(button => button.textContent), ['None', 'GND', 'VCC']);
    fire(buttons[2], 'click');
    const net = controls.get('net');
    assert.equal(net.value, 'VCC');
    net.value = ' NEW ';
    fire(net, 'change');
    assert.deepEqual(commits, ['VCC', 'NEW']);
    assert.equal(otherRow.dataset.prop, 'net');
    assert.equal(otherRow.querySelector('details'), null);
    assert.equal(controls.get('other').placeholder, 'Auto');
}

// Actions render as buttons in titled groups.
{
    const container = panel();
    const ran = [];
    renderPropertyActions(container, [{ title: 'Transform', actions: [
        { id: 'flipH', label: 'Flip H', run: () => ran.push('flipH') },
        { id: 'flipV', label: 'Flip V', disabled: true, run: () => ran.push('flipV') },
    ] }]);
    const [group] = container.children;
    assert.equal(group.dataset.group, 'Transform');
    const [title, items] = group.children;
    assert.equal(title.textContent, 'Transform');
    const [flipH, flipV] = items.children;
    assert.equal(flipV.disabled, true);
    fire(flipH, 'click');
    assert.deepEqual(ran, ['flipH']);
    const other = container.appendChild(document.createElement('div'));
    renderPropertyActions(container, []);
    assert.deepEqual(container.children, [other], 'replacing groups leaves other children alone');
}

// A held spinner (pointer or Arrow key) brackets its run with hold.begin()/end(); the
// release is caught anywhere, and its listeners go with it.
{
    const container = panel();
    const calls = [];
    const input = renderPropertyFields(container, [{ key: 'width', type: 'number', label: 'Width (mm)', value: 1,
        hold: { begin: () => calls.push('begin'), end: () => calls.push('end') } }]).get('width');
    const release = (type, extra = {}) => window.dispatchEvent({ type, ...extra });
    for (const [start, end, details] of [
        ['pointerdown', 'pointerup', { button: 0, pointerId: 1 }],
        ['pointerdown', 'pointercancel', { button: 0, pointerId: 2 }],
        ['keydown', 'keyup', { key: 'ArrowUp' }],
        ['pointerdown', 'blur', { button: 0, pointerId: 3 }],
    ]) {
        calls.length = 0;
        fire(input, start, details);
        fire(input, start, { ...details, repeat: true });
        if (start === 'pointerdown') release('pointerup', { pointerId: 99 });
        assert.deepEqual(calls, ['begin'], `${start}: one hold, other pointers' releases ignored`);
        release(end, details);
        release(end, details);
        assert.deepEqual(calls, ['begin', 'end'], `${end} ends the hold once and removes its listeners`);
    }
    calls.length = 0;
    fire(input, 'pointerdown', { button: 2, pointerId: 4 });
    fire(input, 'keydown', { key: 'a' });
    assert.deepEqual(calls, [], 'other buttons and keys are not holds');
}

console.log('property field engine tests passed');
