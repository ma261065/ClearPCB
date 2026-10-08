/**
 * Shared ribbon renderer.
 *
 * Editors describe tabs, panels, groups and items as plain data. This module is
 * the only place that turns that description into ribbon DOM, binds item events
 * and synchronizes item state.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgTags = new Set(['svg', 'path', 'circle', 'line', 'rect', 'polyline', 'polygon']);

const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const valueOf = value => typeof value === 'function' ? value() : value;
const optionsOf = desc => valueOf(desc.options) || [];

function textNode(text) {
    if (document.createTextNode) return document.createTextNode(String(text));
    const node = document.createElement('span');
    node.textContent = String(text);
    return node;
}

function setAttr(node, name, value) {
    if (value === undefined || value === null || value === false) return;
    if (name === 'value') node.value = String(value);
    if (name === 'type') node.type = String(value);
    if (name === 'checked') node.checked = !!value;
    if (name === 'disabled') node.disabled = !!value;
    if (['min', 'max', 'step'].includes(name)) node[name] = String(value);
    if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
}

function toggleClass(node, name, force) {
    if (node.classList?.toggle) node.classList.toggle(name, force);
    const classes = new Set(String(node.getAttribute?.('class') || node.className || '').split(/\s+/).filter(Boolean));
    if (force) classes.add(name);
    else classes.delete(name);
    const value = [...classes].join(' ');
    node.setAttribute?.('class', value);
    if (typeof node.className === 'string') node.className = value;
}

function element(tag, options = {}) {
    const node = svgTags.has(tag)
        ? document.createElementNS(SVG_NS, tag)
        : document.createElement(tag);
    if (options.id) node.id = options.id;
    if (options.className) {
        node.setAttribute('class', options.className);
        if (typeof node.className === 'string') node.className = options.className;
    }
    if (options.title) node.setAttribute('title', String(valueOf(options.title)));
    if (options.text !== undefined) node.textContent = String(valueOf(options.text));
    for (const [name, value] of Object.entries(options.attrs || {})) setAttr(node, name, valueOf(value));
    for (const [name, value] of Object.entries(options.dataset || {})) node.dataset[name] = String(valueOf(value));
    return node;
}

function setContent(node, content, context) {
    const rendered = asArray(valueOf(content)).map(item => {
        if (item === null || item === undefined) return null;
        if (typeof item === 'string' || typeof item === 'number') return textNode(item);
        if (typeof Node !== 'undefined' && item instanceof Node) return item;
        return item.kind && item.kind !== 'element'
            ? renderRibbonItem(item, context).node
            : renderElement(item, context);
    }).filter(Boolean);
    const text = rendered.map(child => child.textContent).join('');
    if (node.textContent === text && node.children?.length === rendered.length) return;
    node.textContent = '';
    for (const child of rendered) node.appendChild(child);
}

function appendContent(parent, content, context) {
    for (const child of asArray(valueOf(content))) {
        if (child === null || child === undefined) continue;
        if (typeof child === 'string' || typeof child === 'number') parent.appendChild(textNode(child));
        else if (typeof Node !== 'undefined' && child instanceof Node) parent.appendChild(child);
        else if (child.kind && child.kind !== 'element') parent.appendChild(renderRibbonItem(child, context).node);
        else parent.appendChild(renderElement(child, context));
    }
}

function register(context, desc, node, control = node) {
    if (desc.id) context.controls.set(desc.id, control || node);
    context.stateful.push({ desc, node, control: control || node });
}

function renderElement(desc, context) {
    const node = element(desc.tag || 'div', desc);
    if (desc.run) {
        node.addEventListener('click', e => {
            desc.run(e, context.api);
            if (desc.refreshOnRun !== false) context.api.refresh();
        });
    }
    if (desc.onInput) {
        node.addEventListener('input', e => {
            desc.onInput(node.value, e, context.api);
            if (desc.refreshOnInput !== false) context.api.refresh();
        });
    }
    if (desc.onChange) {
        node.addEventListener('change', e => {
            desc.onChange(node.value, e, context.api);
            if (desc.refreshOnChange !== false) context.api.refresh();
        });
    }
    register(context, desc, node);
    appendContent(node, desc.children, context);
    return node;
}

function renderButton(desc, context, extraClass = '') {
    const className = [extraClass, desc.className].filter(Boolean).join(' ');
    const button = element('button', { ...desc, className });
    if (desc.type) button.type = desc.type;
    else if (!button.hasAttribute?.('type')) button.type = 'button';
    appendContent(button, desc.content ?? desc.label ?? desc.text, context);
    if (desc.run) {
        button.addEventListener('click', e => {
            desc.run(e, context.api);
            context.api.refresh();
        });
    }
    return button;
}

function clearOptions(select) {
    select.textContent = '';
    while (select.firstChild) select.removeChild(select.firstChild);
    if (!select.children) select.children = [];
}

function appendOption(select, desc) {
    if (desc.separatorBefore) {
        const separator = element('option', { attrs: { value: '', disabled: true } });
        separator.textContent = '─'.repeat(12);
        select.appendChild(separator);
    }
    if (desc.options) {
        const group = element('optgroup', { attrs: { label: desc.label } });
        for (const child of desc.options) appendOption(group, child);
        select.appendChild(group);
        return;
    }
    const option = element('option', {
        attrs: { value: desc.value, selected: desc['selected'], disabled: desc.disabled },
        dataset: desc.dataset,
        title: desc.title,
    });
    option.textContent = desc.label ?? desc.text ?? desc.value ?? '';
    select.appendChild(option);
}

function syncSelectOptions(select, desc) {
    clearOptions(select);
    for (const option of optionsOf(desc)) appendOption(select, option);
}

function renderSelect(desc, context) {
    const select = element('select', desc);
    syncSelectOptions(select, desc);
    if (desc.value !== undefined) select.value = String(valueOf(desc.value));
    if (desc.onChange) {
        select.addEventListener('change', e => {
            desc.onChange(select.value, e, context.api);
            context.api.refresh();
        });
    }
    return select;
}

function renderCheckbox(desc, context) {
    const label = element('label', { className: desc.className || 'ribbon-checkbox' });
    const input = element('input', { id: desc.id, title: desc.title, attrs: { type: 'checkbox' } });
    input.checked = !!valueOf(desc.checked);
    input.disabled = !!valueOf(desc.disabled);
    if (desc.onChange) {
        input.addEventListener('change', e => {
            desc.onChange(!!input.checked, e, context.api);
            context.api.refresh();
        });
    }
    label.appendChild(input);
    appendContent(label, [' ', desc.label ?? desc.text ?? ''], context);
    if (desc.id) context.controls.set(desc.id, input);
    return { node: label, control: input };
}

function renderSlot(desc, context) {
    const node = element(desc.tag || 'div', desc);
    register(context, desc, node);
    appendContent(node, desc.children, context);
    return node;
}

function menuIsOpen(menu, usesHidden) {
    return usesHidden ? !menu.hidden : menu.classList.contains('open');
}

function setMenuOpen(menu, open, usesHidden) {
    if (usesHidden) menu.hidden = !open;
    else menu.classList.toggle('open', open);
}

function bindMenu(context, desc, wrapper, menu, toggles) {
    const usesHidden = menu.hasAttribute?.('hidden') || menu.hidden === true;
    const close = () => {
        setMenuOpen(menu, false, usesHidden);
        for (const toggle of toggles) toggle.setAttribute?.('aria-expanded', 'false');
    };
    const open = () => {
        context.closeMenus();
        desc.onOpen?.({ menu, api: context.api });
        setMenuOpen(menu, true, usesHidden);
        for (const toggle of toggles) toggle.setAttribute?.('aria-expanded', 'true');
        context.api.refresh();
    };
    const toggle = e => {
        e.preventDefault?.();
        e.stopPropagation?.();
        if (menuIsOpen(menu, usesHidden)) close();
        else open();
    };
    for (const button of toggles) button.addEventListener('click', toggle);
    context.menuClosers.push(close);
    document.addEventListener('click', e => {
        const target = /** @type {Node|null} */ (e.target);
        if (!target || !wrapper.contains(target)) close();
    });
    return { close, open, toggle };
}

function renderMenuItems(menu, items, context, closeMenu) {
    for (const item of items || []) {
        if (item.kind === 'separator') {
            menu.appendChild(element('div', { className: item.className || 'dropdown-separator' }));
            continue;
        }
        const rendered = renderRibbonItem({
            ...item,
            run: item.run ? (e, api) => {
                item.run(e, api);
                closeMenu?.();
            } : item.run,
        }, context);
        menu.appendChild(rendered.node);
    }
}

function renderDropdown(desc, context) {
    const wrapper = element('div', { id: desc.id, className: desc.className || 'dropdown' });
    const button = renderButton(desc.button || {}, context);
    const menu = element('div', {
        id: desc.menuId,
        className: desc.menuClassName || 'dropdown-menu',
        attrs: desc.menuAttrs,
    });
    const binding = bindMenu(context, desc, wrapper, menu, [button]);
    renderMenuItems(menu, desc.items, context, binding.close);
    wrapper.append(button, menu);
    register(context, desc, wrapper);
    if (desc.menuId) context.controls.set(desc.menuId, menu);
    return { node: wrapper, controls: [button, menu] };
}

function renderSplitDropdown(desc, context) {
    const wrapper = element('div', { id: desc.id, className: desc.className || 'dropdown split-dropdown' });
    const main = renderButton(desc.main || {}, context);
    const arrow = renderButton({ ...(desc.arrow || {}), run: undefined }, context, desc.arrow?.className || 'dropdown-caret');
    const menu = element('div', { id: desc.menuId, className: desc.menuClassName || 'dropdown-menu', attrs: desc.menuAttrs });
    const binding = bindMenu(context, desc, wrapper, menu, [arrow]);
    renderMenuItems(menu, desc.items, context, binding.close);
    wrapper.append(main, arrow, menu);
    register(context, desc, wrapper);
    if (desc.menuId) context.controls.set(desc.menuId, menu);
    return { node: wrapper, controls: [main, arrow, menu] };
}

function renderSplitTool(desc, context) {
    const wrapper = element('div', { id: desc.id, className: desc.className || 'ribbon-tool-dropdown ribbon-split-btn' });
    const main = renderButton(desc.main || {}, context, desc.main?.className || 'ribbon-tool-btn ribbon-split-main');
    const arrow = renderButton({ ...(desc.arrow || {}), run: undefined }, context, desc.arrow?.className || 'ribbon-tool-btn ribbon-split-arrow');
    const menu = element('div', {
        id: desc.menuId,
        className: desc.menuClassName || 'ribbon-tool-menu',
        attrs: { hidden: desc.hidden ?? true, ...desc.menuAttrs },
    });
    const binding = bindMenu(context, desc, wrapper, menu, [arrow]);
    renderMenuItems(menu, desc.items, context, binding.close);
    wrapper.append(main, arrow, menu);
    register(context, desc, wrapper);
    if (desc.menuId) context.controls.set(desc.menuId, menu);
    return { node: wrapper, controls: [main, arrow, menu] };
}

function renderHelpRow(desc, context) {
    const row = element('div', { className: 'help-row' });
    appendContent(row, desc.children, context);
    return row;
}

function renderRibbonItem(desc, context) {
    if (!desc) return { node: textNode('') };
    let rendered;
    if (desc.kind === 'button') rendered = { node: renderButton(desc, context), control: null };
    else if (desc.kind === 'toolButton') rendered = { node: renderButton(desc, context, 'ribbon-tool-btn'), control: null };
    else if (desc.kind === 'checkbox') rendered = renderCheckbox(desc, context);
    else if (desc.kind === 'select') rendered = { node: renderSelect(desc, context), control: null };
    else if (desc.kind === 'slot') rendered = { node: renderSlot(desc, context), control: null };
    else if (desc.kind === 'propertyPlaceholder') rendered = { node: element('span', { className: 'props-placeholder', text: desc.text }), control: null };
    else if (desc.kind === 'dropdown') rendered = renderDropdown(desc, context);
    else if (desc.kind === 'splitDropdown') rendered = renderSplitDropdown(desc, context);
    else if (desc.kind === 'splitTool') rendered = renderSplitTool(desc, context);
    else if (desc.kind === 'helpRow') rendered = { node: renderHelpRow(desc, context), control: null };
    else if (desc.kind === 'element') rendered = { node: renderElement(desc, context), control: null };
    else rendered = { node: renderElement(desc, context), control: null };
    register(context, desc, rendered.node, rendered.control || rendered.node);
    return rendered;
}

function applyState(desc, node, control = node, context) {
    const disabled = valueOf(desc.disabled);
    if (disabled !== undefined) {
        if ('disabled' in control) control.disabled = !!disabled;
        toggleClass(node, 'disabled', !!disabled);
    }
    const active = valueOf(desc.active);
    if (active !== undefined) toggleClass(node, 'active', !!active);
    for (const [name, value] of Object.entries(desc.classes || {})) toggleClass(node, name, !!valueOf(value));
    if (desc.checked !== undefined) control.checked = !!valueOf(desc.checked);
    if (desc.value !== undefined) control.value = String(valueOf(desc.value));
    if (desc.title !== undefined && node.setAttribute) node.setAttribute('title', String(valueOf(desc.title)));
    for (const [name, value] of Object.entries(desc.attrs || {})) {
        const resolved = valueOf(value);
        if (name === 'value' && desc.value !== undefined) continue;
        setAttr(control, name, resolved);
    }
    if ((desc.content !== undefined || desc.label !== undefined || desc.text !== undefined)
        && (desc.kind === 'button' || desc.kind === 'toolButton')) {
        setContent(node, desc.content ?? desc.label ?? desc.text, context);
    }
    if (desc.kind === 'select' && typeof desc.options === 'function') {
        const previous = control.value;
        syncSelectOptions(control, desc);
        control.value = desc.value !== undefined ? String(valueOf(desc.value)) : previous;
    }
}

/**
 * @param {HTMLElement} container
 * @param {object} description
 */
export function renderRibbon(container, description) {
    container.textContent = '';
    const tabs = [];
    const panels = [];
    let activeTabId = (description.tabs || []).find(tab => tab.active)?.id || description.tabs?.[0]?.id || null;

    const context = {
        controls: new Map(),
        stateful: [],
        menuClosers: [],
        closeMenus: () => context.menuClosers.forEach(close => close()),
        api: null,
    };

    const api = {
        controls: context.controls,
        get activeTab() { return activeTabId; },
        activateTab: (tabId, userInitiated = false) => {
            if (!tabId) return;
            const previous = activeTabId;
            description.onBeforeTabChange?.({ from: previous, to: tabId, userInitiated, api });
            tabs.forEach(tab => toggleClass(tab.el, 'active', tab.id === tabId));
            panels.forEach(panel => toggleClass(panel.el, 'active', panel.id === tabId));
            activeTabId = tabId;
            description.onTabChange?.({ from: previous, to: tabId, userInitiated, api });
            api.refresh();
        },
        refresh: () => {
            for (const entry of context.stateful) applyState(entry.desc, entry.node, entry.control, context);
            description.onRefresh?.(api);
        },
        closeMenus: context.closeMenus,
    };
    context.api = api;

    const tabsEl = element('div', { className: 'ribbon-tabs' });
    for (const tab of description.tabs || []) {
        if (tab.kind === 'spacer') {
            tabsEl.appendChild(element('div', { className: tab.className || 'ribbon-spacer' }));
            continue;
        }
        const tabEl = element('div', {
            className: `ribbon-tab${tab.active ? ' active' : ''}`,
            dataset: { tab: tab.id },
            text: tab.label,
        });
        tabEl.addEventListener('click', () => api.activateTab(tab.id, true));
        tabs.push({ id: tab.id, el: tabEl });
        tabsEl.appendChild(tabEl);
    }

    const panelsEl = element('div', { className: 'ribbon-panels' });
    for (const group of description.persistentGroups || []) panelsEl.appendChild(renderGroup(group));
    for (const panel of description.panels || []) {
        const panelId = panel.panel || panel.id;
        const panelEl = element('div', {
            id: panel.id,
            className: `ribbon-panel${panel.active ? ' active' : ''}${panel.className ? ` ${panel.className}` : ''}`,
            dataset: { panel: panelId },
        });
        appendContent(panelEl, panel.children, context);
        for (const group of panel.groups || []) panelEl.appendChild(renderGroup(group));
        panels.push({ id: panelId, el: panelEl });
        panelsEl.appendChild(panelEl);
        if (panel.id) context.controls.set(panel.id, panelEl);
    }

    container.append(tabsEl, panelsEl);
    if (activeTabId) api.activateTab(activeTabId);
    api.refresh();
    return api;

    function renderGroup(group) {
        const groupEl = element('div', {
            id: group.id,
            className: `ribbon-group${group.className ? ` ${group.className}` : ''}`,
        });
        groupEl.appendChild(element('div', { className: 'ribbon-group-title', text: group.title }));
        const items = element('div', {
            id: group.itemsId,
            className: group.itemsClassName || 'ribbon-group-items',
        });
        for (const item of group.items || []) items.appendChild(renderRibbonItem(item, context).node);
        groupEl.appendChild(items);
        if (group.id) context.controls.set(group.id, groupEl);
        if (group.itemsId) context.controls.set(group.itemsId, items);
        return groupEl;
    }
}
