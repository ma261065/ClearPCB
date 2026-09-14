export function formatNumberInput(input) {
    if (!input.matches('input[type="number"]') || input.dataset.numberFormat === 'rotation') return;
    const value = input.valueAsNumber;
    if (!Number.isFinite(value)) return;
    const formatted = value.toFixed(2);
    if (input.value !== formatted) input.value = formatted;
}

export function installNumberInputFormatting(root = document) {
    const formatTree = node => {
        if (node.nodeType !== 1 || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
        formatNumberInput(node);
        node.querySelectorAll('input[type="number"]').forEach(formatNumberInput);
    };
    root.querySelectorAll('input[type="number"]').forEach(formatNumberInput);
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.target?.namespaceURI === 'http://www.w3.org/2000/svg') continue;
            if (record.type === 'attributes') formatNumberInput(record.target);
            else record.addedNodes.forEach(formatTree);
        }
    });
    observer.observe(root.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['value', 'type', 'data-number-format'],
    });
    const onEdit = event => {
        const input = event.target;
        if (!input?.matches?.('input[type="number"]')) return;
        if (event.type === 'input' && event.inputType) return;
        queueMicrotask(() => formatNumberInput(input));
    };
    for (const name of ['input', 'change', 'focusout']) root.addEventListener(name, onEdit, true);
    return () => {
        observer.disconnect();
        for (const name of ['input', 'change', 'focusout']) root.removeEventListener(name, onEdit, true);
    };
}