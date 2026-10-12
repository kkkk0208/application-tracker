export const STORAGE_KEY = "applicationTracker.records";
export const PROFILE_STORAGE_KEY = "applicationTracker.profile";
export const QUESTION_MEMORY_STORAGE_KEY = "applicationTracker.questionMemory";
export const AI_SETTINGS_STORAGE_KEY = "applicationTracker.aiSettings";
export const AI_PROFILE_MEMORY_STORAGE_KEY = "applicationTracker.aiProfileMemory";

export const STATUSES = [
  { key: "applied", label: "已投递 / Applied" },
  { key: "oa", label: "OA / 笔试 / Online Assessment" },
  { key: "first_interview", label: "一面 / 1st Interview" },
  { key: "second_interview", label: "二面 / 2nd Interview" },
  { key: "final_interview", label: "HR 面 / 终面 / Final" },
  { key: "offer", label: "Offer" },
  { key: "rejected", label: "Rejected / 被拒" },
  { key: "withdrawn", label: "Withdrawn / 自己撤回 / 拒掉 offer" },
  { key: "on_hold", label: "冻结 / 等待中 / On Hold" }
];

export const SOURCES = [
  { key: "company_portal", label: "公司官网 / Portal" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "jobsdb", label: "JobsDB" },
  { key: "ctgoodjobs", label: "CTgoodjobs" },
  { key: "boss", label: "BOSS 直聘" },
  { key: "referral", label: "内推 / Referral" },
  { key: "other", label: "其他" }
];

export const STATUS_KEYS = new Set(STATUSES.map((status) => status.key));
export const SOURCE_KEYS = new Set(SOURCES.map((source) => source.key));
export const DEFAULT_STATUS = "applied";
export const DEFAULT_SOURCE = "company_portal";
