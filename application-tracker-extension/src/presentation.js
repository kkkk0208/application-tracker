const ACTIVE_STATUSES = new Set(["applied", "oa", "first_interview", "second_interview", "final_interview", "on_hold"]);
const REJECTED_STATUSES = new Set(["rejected", "withdrawn"]);

const STATUS_TONES = {
  applied: "neutral",
  oa: "active",
  first_interview: "active",
  second_interview: "active",
  final_interview: "active",
  offer: "success",
  rejected: "danger",
  withdrawn: "danger",
  on_hold: "warning"
};

export function getStatusTone(status) {
  return STATUS_TONES[status] || "neutral";
}

export function summarizeRecords(records) {
  return {
    total: records.length,
    active: records.filter((record) => ACTIVE_STATUSES.has(record.status)).length,
    offers: records.filter((record) => record.status === "offer").length,
    rejected: records.filter((record) => REJECTED_STATUSES.has(record.status)).length
  };
}

export function getCompanyInitial(company) {
  return company?.trim()?.at(0)?.toUpperCase() || "?";
}
