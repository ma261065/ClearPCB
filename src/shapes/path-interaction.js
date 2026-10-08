/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {{
 *   segmentAt: (point: Point) => any,
 *   selectedSegment: () => any,
 *   selectSegment: (segment: any) => void,
 *   begin: (point: Point, segment: any) => any,
 *   update: (...args: any[]) => any,
 *   end: (commit: boolean) => void,
 * }} PathMoveHandlers
 */

/**
 * @param {any} candidate
 * @param {boolean} alreadySelected
 * @param {boolean} [moved]
 * @returns {any}
 */
export function refinePathSegment(candidate, alreadySelected, moved = false) {
    return alreadySelected && !moved && candidate != null ? candidate : null;
}

/**
 * @param {PathMoveHandlers} handlers
 */
export function pathMoveInteraction({ segmentAt, selectedSegment, selectSegment, begin, update, end }) {
    /** @type {any} */
    let candidate = null;
    let refine = false;
    return {
        getSelectedSegment: selectedSegment,
        /**
         * @param {Point} point
         * @param {{alreadySelected?: boolean, selectedSegment?: any}} [options]
         */
        beginMove(point, options = {}) {
            candidate = segmentAt(point);
            refine = !!options.alreadySelected;
            return begin(point, candidate != null && candidate === options.selectedSegment ? candidate : null);
        },
        updateMove: update,
        /**
         * @param {boolean} commit
         * @param {{moved?: boolean}} [options]
         */
        endMove(commit, options = {}) {
            end(commit);
            const segment = refinePathSegment(candidate, refine, options.moved);
            if (commit && segment != null) selectSegment(segment);
        },
    };
}