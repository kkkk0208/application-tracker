export function getSelectedVisibleIds(selectedIds, visibleRecords) {
  return visibleRecords
    .map((record) => record.id)
    .filter((id) => selectedIds.has(id));
}

export function getBulkSelectionState(selectedIds, visibleRecords) {
  const count = getSelectedVisibleIds(selectedIds, visibleRecords).length;
  return {
    checked: visibleRecords.length > 0 && count === visibleRecords.length,
    indeterminate: count > 0 && count < visibleRecords.length,
    count
  };
}

export function toggleAllVisibleIds(selectedIds, visibleRecords, shouldSelect) {
  const nextSelectedIds = new Set(selectedIds);
  for (const record of visibleRecords) {
    if (shouldSelect) {
      nextSelectedIds.add(record.id);
    } else {
      nextSelectedIds.delete(record.id);
    }
  }
  return nextSelectedIds;
}
