export const BOARD_COLUMNS = [
  { key: "applied", label: "已投递", statuses: ["applied"] },
  { key: "assessment", label: "笔试", statuses: ["oa"] },
  { key: "interview", label: "面试", statuses: ["first_interview", "second_interview", "final_interview"] },
  { key: "offer", label: "Offer", statuses: ["offer"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected", "withdrawn"] },
  { key: "on_hold", label: "冻结", statuses: ["on_hold"] }
];

export function groupRecordsForBoard(records) {
  const grouped = Object.fromEntries(BOARD_COLUMNS.map((column) => [column.key, []]));
  const statusToColumn = new Map(
    BOARD_COLUMNS.flatMap((column) => column.statuses.map((status) => [status, column.key]))
  );

  for (const record of records) {
    const columnKey = statusToColumn.get(record.status) || "applied";
    grouped[columnKey].push(record);
  }

  return grouped;
}
