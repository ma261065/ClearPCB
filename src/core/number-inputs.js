/** @param {number} value */
export function formatNumberInputValue(value) {
    return value.toFixed(2);
}

/** Whole degrees shown by `data-number-format="rotation"` inputs. */
/** @param {number} rotation */
export function displayRotationDegrees(rotation) {
    return Math.round(rotation) % 360;
}

/** @param {Element} input */
export function formatNumberInput(input) {
    const numberInput = /** @type {HTMLInputElement} */ (input);
    if (!numberInput.matches('input[type="number"]') || ['rotation', 'precise'].includes(numberInput.dataset.numberFormat || '')) return;
    const value = numberInput.valueAsNumber;
    if (!Number.isFinite(value)) return;
    const formatted = numberInput.dataset.numberFormat === 'integer' ? String(value) : formatNumberInputValue(value);
    if (numberInput.value !== formatted) numberInput.value = formatted;
}

/** @param {Document} [root] */
export function installNumberInputFormatting(root = document) {
    /** @param {Node} node */
    const formatTree = node => {
        const element = /** @type {Element} */ (node);
        if (node.nodeType !== 1 || element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
        formatNumberInput(element);
        element.querySelectorAll('input[type="number"]').forEach(formatNumberInput);
    };
    root.querySelectorAll('input[type="number"]').forEach(formatNumberInput);
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (/** @type {Element} */ (record.target)?.namespaceURI === 'http://www.w3.org/2000/svg') continue;
            if (record.type === 'attributes') formatNumberInput(/** @type {Element} */ (record.target));
            else record.addedNodes.forEach(formatTree);
        }
    });
    observer.observe(root.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['value', 'type', 'data-number-format'],
    });
    /** @param {Event} event */
    const onEdit = event => {
        const input = /** @type {(Element & { matches(selector: string): boolean }) | null} */ (event.target);
        if (!input?.matches?.('input[type="number"]')) return;
        if (event.type === 'input' && 'inputType' in event && /** @type {InputEvent} */ (event).inputType) return;
        queueMicrotask(() => formatNumberInput(input));
    };
    for (const name of ['input', 'change', 'focusout']) root.addEventListener(name, onEdit, true);
    return () => {
        observer.disconnect();
        for (const name of ['input', 'change', 'focusout']) root.removeEventListener(name, onEdit, true);
    };
}