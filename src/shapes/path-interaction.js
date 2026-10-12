/** @typedef {{x: number, y: number}} Point */
/**
 * @template Segment
 * @typedef {{
 *   segmentAt: (point: Point) => Segment|null,
 *   selectedSegment: () => Segment|null,
 *   selectSegment: (segment: Segment) => void,
 *   begin: (point: Point, segment: Segment|null) => unknown,
 *   update: (point: Point) => void,
 *   end: (commit: boolean) => void,
 * }} PathMoveHandlers<Segment>
 */

/**
 * @template Segment
 * @param {Segment} candidate
 * @param {boolean} alreadySelected
 * @param {boolean} [moved]
 * @returns {Segment|null}
 */
export function refinePathSegment(candidate, alreadySelected, moved = false) {
    return alreadySelected && !moved && candidate != null ? candidate : null;
}

/**
 * @template Segment
 * @param {PathMoveHandlers<Segment>} handlers
 */
export function pathMoveInteraction({ segmentAt, selectedSegment, selectSegment, begin, update, end }) {
    /** @type {Segment|null} */
    let candidate = null;
    let refine = false;
    return {
        getSelectedSegment: selectedSegment,
        /**
         * @param {Point} point
         * @param {{alreadySelected?: boolean, selectedSegment?: Segment}} [options]
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