export const COMMON_ANSWER_FIELDS = [
  "visaSponsorship",
  "rightToWork",
  "expectedSalary",
  "earliestStartDate",
  "currentLocation",
  "relocation",
  "languageAbility",
  "whyRole",
  "whyCompany",
  "selfIntroduction"
];

export const PROFILE_FIELDS = [
  "fullName",
  "fullNameZh",
  "englishName",
  "phone",
  "email",
  "masterUniversity",
  "masterUniversityZh",
  "masterDegree",
  "masterDegreeZh",
  "masterMajor",
  "masterMajorZh",
  "masterStartDate",
  "masterGraduationDate",
  "bachelorUniversity",
  "bachelorUniversityZh",
  "bachelorDegree",
  "bachelorDegreeZh",
  "bachelorMajor",
  "bachelorMajorZh",
  "bachelorStartDate",
  "bachelorGraduationDate",
  "internships",
  "commonAnswers",
  "linkedin",
  "github",
  "website"
];

export function emptyCommonAnswers() {
  return Object.fromEntries(COMMON_ANSWER_FIELDS.map((field) => [field, { zh: "", en: "" }]));
}

export function emptyProfile() {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => {
    if (field === "internships") return [field, []];
    if (field === "commonAnswers") return [field, emptyCommonAnswers()];
    return [field, ""];
  }));
}

export function normalizeProfile(profile = {}) {
  const normalized = emptyProfile();
  for (const field of PROFILE_FIELDS) {
    if (field === "internships") {
      normalized[field] = normalizeInternships(profile[field]);
    } else if (field === "commonAnswers") {
      normalized[field] = normalizeCommonAnswers(profile[field]);
    } else {
      normalized[field] = stringValue(profile[field]);
    }
  }

  normalized.masterUniversity ||= stringValue(profile.university);
  normalized.masterDegree ||= stringValue(profile.degree);
  normalized.masterMajor ||= stringValue(profile.major);
  normalized.masterGraduationDate ||= stringValue(profile.graduationDate);

  return normalized;
}

export function profileHasUsableFields(profile) {
  return Object.values(normalizeProfile(profile)).some(hasUsableValue);
}

function hasUsableValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") {
    return Object.values(value).some(hasUsableValue);
  }
  return Boolean(value);
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeCommonAnswers(value) {
  const normalized = emptyCommonAnswers();
  if (!value || typeof value !== "object") return normalized;

  for (const field of COMMON_ANSWER_FIELDS) {
    const entry = value[field];
    if (entry && typeof entry === "object") {
      normalized[field] = {
        zh: stringValue(entry.zh),
        en: stringValue(entry.en)
      };
    } else {
      normalized[field] = {
        zh: stringValue(entry),
        en: ""
      };
    }
  }

  return normalized;
}

function normalizeInternships(value) {
  if (typeof value === "string") {
    return normalizeInternships([parseLegacyInternship(value)]);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      company: stringValue(item?.company),
      companyZh: stringValue(item?.companyZh),
      role: stringValue(item?.role),
      roleZh: stringValue(item?.roleZh),
      period: stringValue(item?.period),
      description: stringValue(item?.description),
      descriptionZh: stringValue(item?.descriptionZh)
    }))
    .filter((item) => Object.values(item).some(Boolean));
}

function parseLegacyInternship(value) {
  const [company = "", role = "", period = "", ...descriptionParts] = String(value).split("|");
  return {
    company,
    role,
    period,
    description: descriptionParts.join("|")
  };
}
