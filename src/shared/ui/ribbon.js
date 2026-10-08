/**
 * Shared ribbon renderer.
 *
 * Editors describe tabs, panels, groups and items as plain data. This module is
 * the only place that turns that description into ribbon DOM, binds item events
 * and synchronizes item state.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgTags = new Set(['svg', 'path', 'circle', 'line', 'rect', 'polyline', 'polygon']);

/**
 * @template T
 * @typedef {T|(() => T)} RibbonValue
 */

/**
 * @typedef {string|number|boolean|null|undefined} RibbonPrimitive
 * @typedef {string|number|null|undefined|Node|RibbonElementDescription|RibbonItemDescription} RibbonChild
 * @typedef {RibbonValue<RibbonChild|RibbonChild[]>} RibbonContent
 * @typedef {RibbonValue<RibbonPrimitive>} RibbonAttributeValue
 * @typedef {(HTMLElement|SVGElement) & {[key: string]: any}} RibbonElement Dynamic renderer stores per-control DOM state.
 * @typedef {HTMLElement & {[key: string]: any}} RibbonControl Dynamic renderer stores per-control DOM state.
 * @typedef {{value?: string|number|boolean|null, label?: string|number, text?: string|number, title?: RibbonContent, selected?: RibbonValue<boolean>, disabled?: RibbonValue<boolean>, separatorBefore?: boolean, dataset?: Record<string, RibbonAttributeValue>, options?: RibbonOptionDescription[]}} RibbonOptionDescription
 * @typedef {(event: Event, api: RibbonApi) => void} RibbonAction
 * @typedef {((value: string, event: Event, api: RibbonApi) => void)|((value: boolean, event: Event, api: RibbonApi) => void)} RibbonValueAction
 * @typedef {{from: string, to: string, userInitiated: boolean, api: RibbonApi}} RibbonTabChangeEvent
 * @typedef {{menu: HTMLElement, api: RibbonApi}} RibbonMenuOpenEvent
 * @typedef {object} RibbonElementDescription
 * @property {string} [kind]
 * @property {string} [tag]
 * @property {string} [id]
 * @property {string} [className]
 * @property {RibbonContent} [title]
 * @property {RibbonContent} [text]
 * @property {RibbonContent} [label]
 * @property {RibbonContent} [content]
 * @property {RibbonContent} [children]
 * @property {Record<string, RibbonAttributeValue>} [attrs]
 * @property {Record<string, RibbonAttributeValue>} [dataset]
 * @property {Record<string, RibbonValue<boolean>>} [classes]
 * @property {RibbonValue<boolean>} [disabled]
 * @property {RibbonValue<boolean>} [active]
 * @property {RibbonValue<boolean>} [checked]
 * @property {RibbonAttributeValue} [value]
 * @property {RibbonAction} [run]
 * @property {RibbonValueAction} [onInput]
 * @property {RibbonValueAction} [onChange]
 * @property {boolean} [refreshOnRun]
 * @property {boolean} [refreshOnInput]
 * @property {boolean} [refreshOnChange]
 * @typedef {RibbonElementDescription & {kind?: string, type?: string, button?: RibbonItemDescription, main?: RibbonItemDescription, arrow?: RibbonItemDescription, menuId?: string, menuClassName?: string, menuAttrs?: Record<string, RibbonAttributeValue>, items?: RibbonItemDescription[], options?: RibbonValue<RibbonOptionDescription[]>, separatorBefore?: boolean, hidden?: boolean, onOpen?: (event: RibbonMenuOpenEvent) => void}} RibbonItemDescription
 * @typedef {{kind?: string, id?: string, label?: RibbonContent, active?: boolean, className?: string}} RibbonTabDescription
 * @typedef {{id?: string, title?: RibbonContent, className?: string, itemsId?: string, itemsClassName?: string, items?: RibbonItemDescription[]}} RibbonGroupDescription
 * @typedef {{id?: string, panel?: string, active?: boolean, className?: string, children?: RibbonContent, groups?: RibbonGroupDescription[]}} RibbonPanelDescription
 * @typedef {{tabs?: RibbonTabDescription[], panels?: RibbonPanelDescription[], persistentGroups?: RibbonGroupDescription[], onBeforeTabChange?: (event: RibbonTabChangeEvent) => void, onTabChange?: (event: RibbonTabChangeEvent) => void, onRefresh?: (api: RibbonApi) => void}} RibbonDescription
 * @typedef {{controls: Map<string, HTMLElement>, activeTab: string|null, activateTab: (tabId: string|null|undefined, userInitiated?: boolean) => void, refresh: () => void, closeMenus: () => void}} RibbonApi
 * @typedef {{desc: RibbonItemDescription|RibbonElementDescription, node: RibbonElement, control: RibbonElement}} RibbonStateEntry
 * @typedef {{controls: Map<string, HTMLElement>, stateful: RibbonStateEntry[], menuClosers: Array<() => void>, closeMenus: () => void, api: RibbonApi|null}} RibbonRenderContext
 * @typedef {{node: Node, control?: RibbonElement|null, controls?: RibbonElement[]}} RenderedRibbonItem
 */

/** @template T @param {T|T[]|null|undefined} value @returns {T[]} */
const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
/** @template T @param {RibbonValue<T>|undefined} value @returns {T|undefined} */
const valueOf = value => typeof value === 'function' ? /** @type {() => T} */ (value)() : value;
/** @param {{options?: RibbonValue<RibbonOptionDescription[]>}} desc @returns {RibbonOptionDescription[]} */
const optionsOf = desc => valueOf(desc.options) || [];

/** @param {RibbonContent} text @returns {Node} */
function textNode(text) {
    if (document.createTextNode) return document.createTextNode(String(text));
    const node = document.createElement('span');
    node.textContent = String(text);
    return node;
}

/** @param {RibbonElement} node @param {string} name @param {RibbonAttributeValue} value */
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

/** @param {RibbonElement} node @param {string} name @param {boolean} force */
function toggleClass(node, name, force) {
    if (node.classList?.toggle) node.classList.toggle(name, force);
    const classes = new Set(String(node.getAttribute?.('class') || node.className || '').split(/\s+/).filter(Boolean));
    if (force) classes.add(name);
    else classes.delete(name);
    const value = [...classes].join(' ');
    node.setAttribute?.('class', value);
    if (typeof node.className === 'string') /** @type {{className: string}} */ (node).className = value;
}

/** @param {string} tag @param {RibbonElementDescription} [options] @returns {RibbonElement} */
function element(tag, options = {}) {
    const node = /** @type {RibbonElement} */ (svgTags.has(tag)
        ? document.createElementNS(SVG_NS, tag)
        : document.createElement(tag));
    if (options.id) node.id = options.id;
    if (options.className) {
        node.setAttribute('class', options.className);
        if (typeof node.className === 'string') /** @type {{className: string}} */ (node).className = options.className;
    }
    if (options.title) node.setAttribute('title', String(valueOf(options.title)));
    if (options.text !== undefined) node.textContent = String(valueOf(options.text));
    for (const [name, value] of Object.entries(options.attrs || {})) setAttr(node, name, valueOf(value));
    for (const [name, value] of Object.entries(options.dataset || {})) node.dataset[name] = String(valueOf(value));
    return node;
}

/** @param {RibbonElement} node @param {RibbonContent|undefined} content @param {RibbonRenderContext} context */
function setContent(node, content, context) {
    const rendered = asArray(valueOf(content)).map(item => {
        if (item === null || item === undefined) return null;
        if (typeof item === 'string' || typeof item === 'number') return textNode(item);
        if (typeof Node !== 'undefined' && item instanceof Node) return item;
        const desc = /** @type {RibbonItemDescription|RibbonElementDescription} */ (item);
        return desc.kind && desc.kind !== 'element'
            ? renderRibbonItem(/** @type {RibbonItemDescription} */ (desc), context).node
            : renderElement(desc, context);
    }).filter(Boolean);
    const nodes = /** @type {Node[]} */ (rendered);
    const text = nodes.map(child => child.textContent).join('');
    if (node.textContent === text && node.children?.length === rendered.length) return;
    node.textContent = '';
    for (const child of nodes) node.appendChild(child);
}

/** @param {RibbonElement} parent @param {RibbonContent|undefined} content @param {RibbonRenderContext} context */
function appendContent(parent, content, context) {
    for (const child of asArray(valueOf(content))) {
        if (child === null || child === undefined) continue;
        if (typeof child === 'string' || typeof child === 'number') parent.appendChild(textNode(child));
        else if (typeof Node !== 'undefined' && child instanceof Node) parent.appendChild(child);
        else {
            const desc = /** @type {RibbonItemDescription|RibbonElementDescription} */ (child);
            if (desc.kind && desc.kind !== 'element') parent.appendChild(renderRibbonItem(/** @type {RibbonItemDescription} */ (desc), context).node);
            else parent.appendChild(renderElement(desc, context));
        }
    }
}

/** @param {RibbonRenderContext} context @param {RibbonItemDescription|RibbonElementDescription} desc @param {RibbonElement} node @param {RibbonElement} [control] */
function register(context, desc, node, control = node) {
    if (desc.id) context.controls.set(desc.id, /** @type {HTMLElement} */ (control || node));
    context.stateful.push({ desc, node, control: control || node });
}

/** @param {RibbonElementDescription} desc @param {RibbonRenderContext} context @returns {RibbonElement} */
function renderElement(desc, context) {
    const node = element(desc.tag || 'div', desc);
    if (desc.run) {
        node.addEventListener('click', e => {
            (/** @type {RibbonAction} */ (desc.run))(e, /** @type {RibbonApi} */ (context.api));
            if (desc.refreshOnRun !== false) /** @type {RibbonApi} */ (context.api).refresh();
        });
    }
    if (desc.onInput) {
        node.addEventListener('input', e => {
            (/** @type {(value: string, event: Event, api: RibbonApi) => void} */ (desc.onInput))(String(node.value ?? ''), e, /** @type {RibbonApi} */ (context.api));
            if (desc.refreshOnInput !== false) /** @type {RibbonApi} */ (context.api).refresh();
        });
    }
    if (desc.onChange) {
        node.addEventListener('change', e => {
            (/** @type {(value: string, event: Event, api: RibbonApi) => void} */ (desc.onChange))(String(node.value ?? ''), e, /** @type {RibbonApi} */ (context.api));
            if (desc.refreshOnChange !== false) /** @type {RibbonApi} */ (context.api).refresh();
        });
    }
    register(context, desc, node);
    appendContent(node, desc.children, context);
    return node;
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @param {string} [extraClass] @returns {HTMLButtonElement} */
function renderButton(desc, context, extraClass = '') {
    const className = [extraClass, desc.className].filter(Boolean).join(' ');
    const button = /** @type {HTMLButtonElement} */ (element('button', { ...desc, className }));
    if (desc.type) button.type = /** @type {"button"|"reset"|"submit"} */ (desc.type);
    else if (!button.hasAttribute?.('type')) button.type = 'button';
    appendContent(button, desc.content ?? desc.label ?? desc.text, context);
    if (desc.run) {
        button.addEventListener('click', e => {
            (/** @type {RibbonAction} */ (desc.run))(e, /** @type {RibbonApi} */ (context.api));
            /** @type {RibbonApi} */ (context.api).refresh();
        });
    }
    return button;
}

/** @param {HTMLSelectElement} select */
function clearOptions(select) {
    select.textContent = '';
    while (select.firstChild) select.removeChild(select.firstChild);
    if (!select.children) (/** @type {{children: unknown[]}} */ (/** @type {unknown} */ (select))).children = [];
}

/** @param {HTMLSelectElement|HTMLOptGroupElement} select @param {RibbonOptionDescription} desc */
function appendOption(select, desc) {
    if (desc.separatorBefore) {
        const separator = /** @type {HTMLOptionElement} */ (element('option', { attrs: { value: '', disabled: true } }));
        separator.textContent = '─'.repeat(12);
        select.appendChild(separator);
    }
    if (desc.options) {
        const group = /** @type {HTMLOptGroupElement} */ (element('optgroup', { attrs: { label: desc.label } }));
        for (const child of desc.options) appendOption(group, child);
        select.appendChild(group);
        return;
    }
    const option = /** @type {HTMLOptionElement} */ (element('option', {
        attrs: { value: desc.value, selected: desc['selected'], disabled: desc.disabled },
        dataset: desc.dataset,
        title: desc.title,
    }));
    option.textContent = String(desc.label ?? desc.text ?? desc.value ?? '');
    select.appendChild(option);
}

/** @param {HTMLSelectElement} select @param {{options?: RibbonValue<RibbonOptionDescription[]>}} desc */
function syncSelectOptions(select, desc) {
    clearOptions(select);
    for (const option of optionsOf(desc)) appendOption(select, option);
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {HTMLSelectElement} */
function renderSelect(desc, context) {
    const select = /** @type {HTMLSelectElement} */ (element('select', desc));
    syncSelectOptions(select, desc);
    if (desc.value !== undefined) select.value = String(valueOf(desc.value));
    if (desc.onChange) {
        select.addEventListener('change', e => {
            (/** @type {(value: string, event: Event, api: RibbonApi) => void} */ (desc.onChange))(select.value, e, /** @type {RibbonApi} */ (context.api));
            /** @type {RibbonApi} */ (context.api).refresh();
        });
    }
    return select;
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {{node: RibbonElement, control: HTMLInputElement}} */
function renderCheckbox(desc, context) {
    const label = element('label', { className: desc.className || 'ribbon-checkbox' });
    const input = /** @type {HTMLInputElement} */ (element('input', { id: desc.id, title: desc.title, attrs: { type: 'checkbox' } }));
    input.checked = !!valueOf(desc.checked);
    input.disabled = !!valueOf(desc.disabled);
    if (desc.onChange) {
        input.addEventListener('change', e => {
            (/** @type {(value: boolean, event: Event, api: RibbonApi) => void} */ (desc.onChange))(!!input.checked, e, /** @type {RibbonApi} */ (context.api));
            /** @type {RibbonApi} */ (context.api).refresh();
        });
    }
    label.appendChild(input);
    appendContent(label, [' ', /** @type {RibbonChild} */ (desc.label ?? desc.text ?? '')], context);
    if (desc.id) context.controls.set(desc.id, input);
    return { node: label, control: input };
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {RibbonElement} */
function renderSlot(desc, context) {
    const node = element(desc.tag || 'div', desc);
    register(context, desc, node);
    appendContent(node, desc.children, context);
    return node;
}

/** @param {RibbonElement} menu @param {boolean} usesHidden @returns {boolean} */
function menuIsOpen(menu, usesHidden) {
    return usesHidden ? !menu.hidden : menu.classList.contains('open');
}

/** @param {RibbonElement} menu @param {boolean} open @param {boolean} usesHidden */
function setMenuOpen(menu, open, usesHidden) {
    if (usesHidden) menu.hidden = !open;
    else menu.classList.toggle('open', open);
}

/** @param {RibbonRenderContext} context @param {RibbonItemDescription} desc @param {RibbonElement} wrapper @param {RibbonElement} menu @param {RibbonElement[]} toggles @returns {{close: () => void, open: () => void, toggle: (event: Event) => void}} */
function bindMenu(context, desc, wrapper, menu, toggles) {
    const usesHidden = menu.hasAttribute?.('hidden') || menu.hidden === true;
    const close = () => {
        setMenuOpen(menu, false, usesHidden);
        for (const toggle of toggles) toggle.setAttribute?.('aria-expanded', 'false');
    };
    const open = () => {
        context.closeMenus();
        desc.onOpen?.({ menu: /** @type {HTMLElement} */ (menu), api: /** @type {RibbonApi} */ (context.api) });
        setMenuOpen(menu, true, usesHidden);
        for (const toggle of toggles) toggle.setAttribute?.('aria-expanded', 'true');
        /** @type {RibbonApi} */ (context.api).refresh();
    };
    /** @param {Event} e */
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

/** @param {RibbonElement} menu @param {RibbonItemDescription[]|undefined} items @param {RibbonRenderContext} context @param {(() => void)|undefined} closeMenu */
function renderMenuItems(menu, items, context, closeMenu) {
    for (const item of items || []) {
        if (item.kind === 'separator') {
            menu.appendChild(element('div', { className: item.className || 'dropdown-separator' }));
            continue;
        }
        const rendered = renderRibbonItem({
            ...item,
            run: item.run ? (e, api) => {
                (/** @type {RibbonAction} */ (item.run))(e, api);
                closeMenu?.();
            } : item.run,
        }, context);
        menu.appendChild(rendered.node);
    }
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {RenderedRibbonItem} */
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
    if (desc.menuId) context.controls.set(desc.menuId, /** @type {HTMLElement} */ (menu));
    return { node: wrapper, controls: [button, menu] };
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {RenderedRibbonItem} */
function renderSplitDropdown(desc, context) {
    const wrapper = element('div', { id: desc.id, className: desc.className || 'dropdown split-dropdown' });
    const main = renderButton(desc.main || {}, context);
    const arrow = renderButton({ ...(desc.arrow || {}), run: undefined }, context, desc.arrow?.className || 'dropdown-caret');
    const menu = element('div', { id: desc.menuId, className: desc.menuClassName || 'dropdown-menu', attrs: desc.menuAttrs });
    const binding = bindMenu(context, desc, wrapper, menu, [arrow]);
    renderMenuItems(menu, desc.items, context, binding.close);
    wrapper.append(main, arrow, menu);
    register(context, desc, wrapper);
    if (desc.menuId) context.controls.set(desc.menuId, /** @type {HTMLElement} */ (menu));
    return { node: wrapper, controls: [main, arrow, menu] };
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {RenderedRibbonItem} */
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
    if (desc.menuId) context.controls.set(desc.menuId, /** @type {HTMLElement} */ (menu));
    return { node: wrapper, controls: [main, arrow, menu] };
}

/** @param {RibbonItemDescription} desc @param {RibbonRenderContext} context @returns {RibbonElement} */
function renderHelpRow(desc, context) {
    const row = element('div', { className: 'help-row' });
    appendContent(row, desc.children, context);
    return row;
}

/** @param {RibbonItemDescription|null|undefined} desc @param {RibbonRenderContext} context @returns {RenderedRibbonItem} */
function renderRibbonItem(desc, context) {
    if (!desc) return { node: textNode('') };
    /** @type {RenderedRibbonItem} */
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
    register(context, desc, /** @type {RibbonElement} */ (rendered.node), rendered.control || /** @type {RibbonElement} */ (rendered.node));
    return rendered;
}

/** @param {RibbonItemDescription|RibbonElementDescription} desc @param {RibbonElement} node @param {RibbonElement} control @param {RibbonRenderContext} context */
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
    const selectDesc = /** @type {RibbonItemDescription} */ (desc);
    if (desc.kind === 'select' && typeof selectDesc.options === 'function') {
        const previous = control.value;
        syncSelectOptions(/** @type {HTMLSelectElement} */ (control), selectDesc);
        control.value = desc.value !== undefined ? String(valueOf(desc.value)) : previous;
    }
}

/**
 * @param {HTMLElement} container
 * @param {RibbonDescription} description
 * @returns {RibbonApi}
 */
export function renderRibbon(container, description) {
    container.textContent = '';
    /** @type {Array<{id: string|undefined, el: RibbonElement}>} */
    const tabs = [];
    /** @type {Array<{id: string|undefined, el: RibbonElement}>} */
    const panels = [];
    let activeTabId = (description.tabs || []).find(tab => tab.active)?.id || description.tabs?.[0]?.id || null;

    /** @type {RibbonRenderContext} */
    const context = {
        controls: new Map(),
        stateful: [],
        menuClosers: [],
        closeMenus: () => context.menuClosers.forEach(close => close()),
        api: null,
    };

    /** @type {RibbonApi} */
    const api = {
        controls: context.controls,
        get activeTab() { return activeTabId; },
        activateTab: (tabId, userInitiated = false) => {
            if (!tabId) return;
            const previous = activeTabId;
            description.onBeforeTabChange?.({ from: /** @type {string} */ (previous), to: tabId, userInitiated, api });
            tabs.forEach(tab => toggleClass(tab.el, 'active', tab.id === tabId));
            panels.forEach(panel => toggleClass(panel.el, 'active', panel.id === tabId));
            activeTabId = tabId;
            description.onTabChange?.({ from: /** @type {string} */ (previous), to: tabId, userInitiated, api });
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
        if (panel.id) context.controls.set(panel.id, /** @type {HTMLElement} */ (panelEl));
    }

    container.append(tabsEl, panelsEl);
    if (activeTabId) api.activateTab(activeTabId);
    api.refresh();
    return api;

    /** @param {RibbonGroupDescription} group @returns {RibbonElement} */
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
        if (group.id) context.controls.set(group.id, /** @type {HTMLElement} */ (groupEl));
        if (group.itemsId) context.controls.set(group.itemsId, /** @type {HTMLElement} */ (items));
        return groupEl;
    }
}
