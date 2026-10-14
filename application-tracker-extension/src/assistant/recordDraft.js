import { DEFAULT_STATUS } from "../constants.js";
import { toDateInputValue } from "../dateUtils.js";
import { findPotentialDuplicate } from "../duplicates.js";
import { sortRecentJobs } from "../jobInfo/extractJobInfo.js";
import { cleanPortalUrl, validateRecordForSave } from "../model.js";
import { detectSourceFromUrl } from "../sourceDetection.js";

const text = (value) => typeof value === "string" ? value.trim() : "";

export function buildRecordDraft({ url = "", title = "", jobInfo = {}, today = toDateInputValue() } = {}) {
  const info = jobInfo || {};
  const company = text(info.company), role = text(info.role);
  return {
    company, role, base: text(info.base), portalLink: cleanPortalUrl(text(url)), pageTitle: text(title),
    source: detectSourceFromUrl(url), appliedDate: today, status: DEFAULT_STATUS,
    nextActionDate: "", jdText: "", notes: "",
    origin: { company: company ? text(info.source?.company) : "", role: role ? text(info.source?.role) : "" }
  };
}

// Candidates are offered for an explicit choice; they never populate a draft.
export function recentJobChoices(recentJobs, hostname) {
  return sortRecentJobs(recentJobs, hostname).filter((job) => text(job.role)).slice(0, 5);
}

export function recordStatus(draft, records = []) {
  return { duplicate: findPotentialDuplicate(draft, records), errors: validateRecordForSave(draft) };
}
