/**
 * Retain the tallest static ribbon panel without measuring every tab on each switch.
 * @param {HTMLElement} ribbon
 * @returns {() => void}
 */
export function bindRibbonHeight(ribbon) {
    const container = /** @type {HTMLElement|null} */ (ribbon.querySelector('.ribbon-panels'));
    /** @type {number|null} */
    let retainedWidth = null;
    let retainedHeight = '';
    let scheduled = false;

    const retain = () => {
        if (!container) return;
        if (typeof container.getBoundingClientRect !== 'function') return;
        const { width } = container.getBoundingClientRect();
        if (!width || (width === retainedWidth && container.style.minHeight === retainedHeight)) return;

        const panels = Array.from(ribbon.querySelectorAll('.ribbon-panel'));
        const active = panels.map(panel => panel.classList.contains('active'));
        const previousHeight = container.style.minHeight;
        let height = 0;
        try {
            container.style.minHeight = '';
            for (const panel of panels) {
                panels.forEach(other => other.classList.toggle('active', other === panel));
                height = Math.max(height, container.getBoundingClientRect().height);
            }
        } finally {
            panels.forEach((panel, index) => panel.classList.toggle('active', active[index]));
            container.style.minHeight = previousHeight;
        }
        retainedHeight = `${Math.ceil(height)}px`;
        container.style.minHeight = retainedHeight;
        retainedWidth = width;
    };

    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            retain();
        });
    };
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', () => {
        retainedWidth = null;
        schedule();
    });
    return retain;
}
