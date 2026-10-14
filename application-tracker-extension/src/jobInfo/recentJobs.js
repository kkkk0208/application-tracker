import { cleanPortalUrl, getPortalUrl } from "../model.js";

export const RECENT_JOBS_KEY = "applicationTracker.recentJobs";

// These are temporary page observations, never persistent application records.
export async function rememberJob(sessionStorage, pageUrl, info) {
  if (!pageUrl || !info) return;
  const trusted = (key) => ["high", "medium"].includes(info.confidence?.[key]) && info[key];
  if (!trusted("company") && !trusted("role")) return;
  const url = getPortalUrl(cleanPortalUrl(pageUrl));
  if (!url) return;
  const jobs = await loadRecentJobs(sessionStorage);
  const entry = {
    company: trusted("company") || "", role: trusted("role") || "", base: trusted("base") || "",
    url, host: new URL(url).hostname, capturedAt: Date.now(), source: info.source
  };
  await sessionStorage.set({ [RECENT_JOBS_KEY]: [entry, ...jobs.filter((job) => job.url !== url || job.role !== entry.role)].slice(0, 20) });
}

export async function loadRecentJobs(sessionStorage) {
  const stored = (await sessionStorage.get(RECENT_JOBS_KEY))[RECENT_JOBS_KEY];
  return Array.isArray(stored) ? stored : [];
}
