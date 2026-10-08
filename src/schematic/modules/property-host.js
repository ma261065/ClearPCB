import { renderPropertyActions, renderPropertyFields } from '../../shared/ui/property-fields.js';

/** @typedef {{main: HTMLElement, title: HTMLElement, items: HTMLElement, summary: HTMLElement, summaryValue: HTMLElement, fields: HTMLElement}} PropertyHostState */

/** @type {WeakMap<HTMLElement, PropertyHostState>} */
const states = new WeakMap();

/** @param {string} tag @param {string} [className] */
const element = (tag, className = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
};

/** @param {HTMLElement} container */
function createState(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
    const main = element('div', 'ribbon-group schematic-property-group');
    const title = element('div', 'ribbon-group-title');
    const items = element('div', 'ribbon-group-items');
    const summary = element('div', 'prop-row prop-summary');
    const summaryValue = element('span', 'prop-value');
    const fields = element('span', 'prop-fields');
    summary.appendChild(summaryValue);
    items.append(summary, fields);
    main.append(title, items);
    container.appendChild(main);
    const state = { main, title, items, summary, summaryValue, fields };
    states.set(container, state);
    return state;
}

/** @param {HTMLElement} container */
function stateFor(container) {
    const state = states.get(container);
    return state?.main.parentNode === container ? state : createState(container);
}

/**
 * Render a schematic PropertyPanel description into the existing ribbon panel.
 * @param {HTMLElement} container
 * @param {import('../../shared/ui/property-fields.js').PropertyPanel} panel
 */
export function renderSchematicPropertyPanel(container, panel) {
    const state = stateFor(container);
    state.title.textContent = panel.title;
    if (panel.summary) {
        state.summaryValue.textContent = panel.summary;
        if (state.summary.parentNode !== state.items) {
            if (state.items.insertBefore) state.items.insertBefore(state.summary, state.fields);
            else state.items.appendChild(state.summary);
        }
    } else {
        state.summary.remove();
    }
    renderPropertyFields(state.fields, panel.fields, { placeholder: panel.placeholder });
    renderPropertyActions(container, panel.actions || []);
}
