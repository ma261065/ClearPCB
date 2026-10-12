/** The routing summary line printed by the clearance tools and parsed by tools/regression.mjs. */
export function routingSummary(result, routed) {
    return `Routed ${routed}/${result.totalConnectionCount} connections, ${result.tracks.length} tracks, ${result.vias?.length || 0} vias`;
}
