import { DEFAULT_SOURCE } from "./constants.js";

export function detectSourceFromUrl(url) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return DEFAULT_SOURCE;
  }

  if (hostname.endsWith("linkedin.com")) return "linkedin";
  if (hostname.endsWith("jobsdb.com")) return "jobsdb";
  if (hostname.endsWith("ctgoodjobs.hk")) return "ctgoodjobs";
  if (hostname.endsWith("zhipin.com") || hostname.endsWith("bosszhipin.com")) return "boss";

  return DEFAULT_SOURCE;
}

export function isMokaUrl(url) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return hostname === "job.swsmu.com"
    || hostname.endsWith(".mokahr.com")
    || hostname === "mokahr.com";
}
