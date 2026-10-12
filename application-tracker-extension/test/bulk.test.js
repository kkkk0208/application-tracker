import test from "node:test";
import assert from "node:assert/strict";
import {
  getBulkSelectionState,
  getSelectedVisibleIds,
  toggleAllVisibleIds
} from "../src/bulk.js";

test("getSelectedVisibleIds returns selected ids that are currently visible", () => {
  const selectedIds = new Set(["1", "3", "hidden"]);
  const visibleRecords = [{ id: "1" }, { id: "2" }, { id: "3" }];

  assert.deepEqual(getSelectedVisibleIds(selectedIds, visibleRecords), ["1", "3"]);
});

test("getBulkSelectionState detects unchecked, checked, and indeterminate", () => {
  assert.deepEqual(getBulkSelectionState(new Set(), [{ id: "1" }, { id: "2" }]), {
    checked: false,
    indeterminate: false,
    count: 0
  });

  assert.deepEqual(getBulkSelectionState(new Set(["1"]), [{ id: "1" }, { id: "2" }]), {
    checked: false,
    indeterminate: true,
    count: 1
  });

  assert.deepEqual(getBulkSelectionState(new Set(["1", "2"]), [{ id: "1" }, { id: "2" }]), {
    checked: true,
    indeterminate: false,
    count: 2
  });
});

test("toggleAllVisibleIds selects or clears visible ids without touching hidden ids", () => {
  const visibleRecords = [{ id: "1" }, { id: "2" }];
  const selectedIds = new Set(["hidden"]);

  assert.deepEqual([...toggleAllVisibleIds(selectedIds, visibleRecords, true)].sort(), ["1", "2", "hidden"]);
  assert.deepEqual([...toggleAllVisibleIds(new Set(["1", "2", "hidden"]), visibleRecords, false)], ["hidden"]);
});
