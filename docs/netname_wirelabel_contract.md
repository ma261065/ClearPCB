# Net Name vs Wire Label Contract

## Goal
Define a stable data model where electrical identity and display text are not conflated.

- `netName`: canonical electrical identity for a connected net graph.
- `wireLabel`: optional visual annotation attached to a specific wire segment.

This contract is intentionally minimal and backward-friendly for ClearPCB.

## Why both fields
Use both when you need:
- stable net identity independent of visible text object edits,
- multiple visible labels for one net,
- aliasing (short display label vs canonical export name),
- reliable ERC/netlist behavior even when labels are hidden or moved.

If the product stays MVP/simple, you can keep one field and treat labels as canonical. This document defines the dual-field model.

## Data Contract

### Wire shape
```js
{
  type: 'wire',
  id: string,
  start: { x: number, y: number },
  end: { x: number, y: number },

  // canonical net identity (nullable until named)
  netName: string | null,

  // optional per-segment display text
  wireLabel: string | null
}
```

### Netlabel shape
```js
{
  type: 'netlabel',
  id: string,
  x: number,
  y: number,
  angle: number,
  style: string,

  // text entered by user; interpreted as canonical net identity
  text: string,

  // linked Text child remains presentation object only
  labelTextId: string | null
}
```

### Text shape (linked label)
No net authority. Text is visual only.

```js
{
  type: 'text',
  id: string,
  parentComponent: string | null,
  fieldKey: 'netLabel' | 'wireLabel' | null,
  text: string
}
```

## Source-of-truth rules
1. Connected-wire component has exactly one effective canonical name: `netName`.
2. A netlabel rename sets `netName` for the connected component.
3. `wireLabel` never changes connectivity; it is display metadata only.
4. Linked text objects mirror parent display fields and are derived/presentation.

## Conflict rules
Normalize names with trim + case-insensitive compare.

- Allowed: same `netName` repeated anywhere on the same connected component.
- Blocked: assigning a different name to any part of a connected component that already has a different `netName`.
- Allowed: unnamed (`null`) component receives first valid `netName`.
- Allowed: two physically disconnected components sharing same `netName` (global-net semantics).

## Editing behavior

### Place netlabel
- Determine attached connected component.
- If component has `netName == null`: assign from label text.
- If component has `netName != null` and differs from label text: reject with conflict message.

### Rename netlabel text
- Resolve connected component from netlabel anchor.
- Validate against existing component `netName`.
- On success: propagate new `netName` to that component.

### Drag netlabel to new net
- Re-evaluate destination connected component.
- If destination has conflicting `netName`: reject and revert drag.
- Else bind to destination and apply/confirm `netName`.

### Edit wireLabel text
- Update only `wireLabel` (visual). Never mutate `netName`.

## Serialization rules
- Persist `netName` and `wireLabel` on wire records.
- Persist netlabel parent and linked text as currently designed.
- Net extraction/export reads `wire.netName` as canonical name.

## Undo/redo rules
Any command that changes a canonical name must capture:
- previous `netName` of all affected wires in the connected component,
- new `netName` values after mutation,
- linked text sync updates (presentation only).

## Migration plan (incremental)
1. Introduce nullable `wire.netName` with backward-safe defaults.
2. Add net-component utility: get connected wires + current effective net name.
3. In netlabel place/rename/drag flows, write canonical names to `wire.netName`.
4. Keep current conflict checks but swap authority from inferred labels to `wire.netName`.
5. Update export/ERC paths to read `wire.netName`.
6. Keep `wireLabel` behavior unchanged (visual only).

## Backward compatibility strategy
When loading old files with no `wire.netName`:
- infer initial canonical name from existing connected-label behavior,
- write inferred value into runtime `wire.netName`,
- save forward in new format.

## Recommended default for ClearPCB
- Adopt dual-field model now (`netName` + `wireLabel`) but keep UI minimal:
  - no extra panels,
  - no new dialogs,
  - same current editing gestures,
  - conflict alerts remain the same.

This provides a clean base for future ERC/netlist work without increasing immediate UX complexity.
