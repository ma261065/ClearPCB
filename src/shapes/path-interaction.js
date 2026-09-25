export function refinePathSegment(candidate, alreadySelected, moved = false) {
    return alreadySelected && !moved && candidate != null ? candidate : null;
}

export function pathMoveInteraction({ segmentAt, selectedSegment, selectSegment, begin, update, end }) {
    let candidate = null;
    let refine = false;
    return {
        getSelectedSegment: selectedSegment,
        beginMove(point, options = {}) {
            candidate = segmentAt(point);
            refine = !!options.alreadySelected;
            return begin(point, candidate != null && candidate === options.selectedSegment ? candidate : null);
        },
        updateMove: update,
        endMove(commit, options = {}) {
            end(commit);
            const segment = refinePathSegment(candidate, refine, options.moved);
            if (commit && segment != null) selectSegment(segment);
        },
    };
}