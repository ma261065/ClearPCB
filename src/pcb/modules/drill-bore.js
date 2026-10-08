/** Opaque drill masking above normal copper, below selected-track overlays. */
/**
 * @param {{id: string, x: number, y: number, drill: number}} terminal
 * @param {SVGGElement|null|undefined} group
 * @param {string} className
 * @param {string} kind
 * @returns {SVGCircleElement|null}
 */
export function renderDrillBore(terminal, group, className, kind) {
    if (!group || !(terminal.drill > 0)) return null;
    const drill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    drill.setAttribute('cx', String(terminal.x));
    drill.setAttribute('cy', String(terminal.y));
    drill.setAttribute('r', String(terminal.drill / 2));
    drill.setAttribute('fill', 'var(--pcb-drill, #1a1a2e)');
    drill.setAttribute('class', className);
    drill.setAttribute('pointer-events', 'none');
    drill.dataset[`${kind}Id`] = terminal.id;
    group.appendChild(drill);
    return drill;
}
