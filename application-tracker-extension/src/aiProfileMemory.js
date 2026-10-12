import { extractAiSuggestionText, trimForAiContext } from "./aiSuggest.js";

export function buildProfileMemoryPayload({ model, profile = {}, questionMemories = [] }) {
  return {
    model,
    input: [
      {
        role: "system",
        content: [
          "You build a structured personal knowledge library for job application autofill.",
          "Return JSON only.",
          "Use all useful profile fields, education details, internships, common answers, and learned Q&A.",
          "Create stable dot-path keys that can later match application form fields.",
          "Return at most 80 entries. Prefer concise values and aliases.",
          "Keep Chinese and English information separate when both exist.",
          "Do not invent facts. If a value is missing, omit it."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          schema: {
            summary: "short summary of the applicant profile",
            entries: [{
              key: "stable dot path, for example identity.full_name.zh",
              label: "human readable label",
              value: "answer/details to fill",
              language: "zh, en, or blank",
              category: "identity, contact, education, experience, preference, common_answer, or learned_answer",
              aliases: ["form labels/questions this can answer"],
              sourceFields: ["original fields used"]
            }]
          },
          profile: compactProfileForMemory(profile),
          learnedQuestionAnswers: questionMemories.slice(0, 80).map((memory) => ({
            question: trimForAiContext(memory.question, 220),
            displayQuestion: trimForAiContext(memory.displayQuestion || memory.contextPath || memory.question, 260),
            section: memory.section || "",
            group: memory.group || "",
            contextPath: memory.contextPath || "",
            answer: trimForAiContext(memory.answer, 900),
            language: memory.language,
            category: memory.category
          })).filter((memory) => memory.question && memory.answer)
        })
      }
    ],
    max_output_tokens: 5000
  };
}

export async function requestProfileMemory(settings, context, fetchImpl = fetch) {
  if (!settings?.enabled) {
    throw new Error("请先在 AI 设置中启用 AI 建议");
  }
  if (!settings?.apiKey) {
    throw new Error("请先在 AI 设置中填写 API Key");
  }

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(buildProfileMemoryPayload({
      model: settings.model,
      profile: context.profile,
      questionMemories: context.questionMemories
    }))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `AI 请求失败 (${response.status})`);
  }
  return extractProfileMemory(data);
}

export function extractProfileMemory(data) {
  const rawText = extractAiSuggestionText(data);
  const parsed = parseJsonObjectWithDebug(rawText);
  const memory = normalizeProfileMemory(parsed.value);
  if (!memory.entries.length || parsed.status !== "ok") {
    memory.debug = {
      parseStatus: parsed.status,
      rawTextPreview: trimForAiContext(rawText || JSON.stringify(data || {}), 1600),
      rawTextLength: stringValue(rawText).length
    };
  }
  return memory;
}

export function buildLocalProfileMemory({ profile = {}, questionMemories = [] } = {}, now = new Date().toISOString()) {
  const entries = [];

  pushEntry(entries, {
    key: "identity.full_name.zh",
    label: "中文姓名",
    value: profile.fullNameZh,
    language: "zh",
    category: "identity",
    aliases: ["姓名", "中文姓名", "申请人姓名"],
    sourceFields: ["fullNameZh"]
  });
  pushEntry(entries, {
    key: "identity.full_name.en",
    label: "Full name",
    value: profile.fullName,
    language: "en",
    category: "identity",
    aliases: ["Full name", "Legal name", "Applicant name"],
    sourceFields: ["fullName"]
  });
  pushEntry(entries, {
    key: "identity.preferred_name.en",
    label: "Preferred name",
    value: profile.englishName,
    language: "en",
    category: "identity",
    aliases: ["Preferred name", "English name"],
    sourceFields: ["englishName"]
  });

  [
    ["contact.phone", "电话", profile.phone, "", ["电话", "手机号", "Phone", "Mobile"], "phone"],
    ["contact.email", "邮箱", profile.email, "", ["邮箱", "Email"], "email"],
    ["contact.linkedin", "LinkedIn", profile.linkedin, "", ["LinkedIn", "领英"], "linkedin"],
    ["contact.github", "GitHub", profile.github, "", ["GitHub"], "github"],
    ["contact.website", "个人网站", profile.website, "", ["Website", "Portfolio", "个人网站"], "website"]
  ].forEach(([key, label, value, language, aliases, sourceField]) => {
    pushEntry(entries, { key, label, value, language, category: "contact", aliases, sourceFields: [sourceField] });
  });

  addEducationEntries(entries, "master", "硕士教育", "Master Education", profile, {
    university: ["masterUniversityZh", "masterUniversity"],
    degree: ["masterDegreeZh", "masterDegree"],
    major: ["masterMajorZh", "masterMajor"],
    startDate: "masterStartDate",
    graduationDate: "masterGraduationDate"
  });
  addEducationEntries(entries, "bachelor", "本科教育", "Bachelor Education", profile, {
    university: ["bachelorUniversityZh", "bachelorUniversity"],
    degree: ["bachelorDegreeZh", "bachelorDegree"],
    major: ["bachelorMajorZh", "bachelorMajor"],
    startDate: "bachelorStartDate",
    graduationDate: "bachelorGraduationDate"
  });

  if (Array.isArray(profile.internships)) {
    profile.internships.forEach((internship, index) => addInternshipEntries(entries, internship, index));
  }

  Object.entries(profile.commonAnswers || {}).forEach(([field, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.entries(value).forEach(([language, answer]) => {
        pushEntry(entries, {
          key: `common_answer.${field}.${language}`,
          label: field,
          value: answer,
          language,
          category: "common_answer",
          aliases: [field],
          sourceFields: [`commonAnswers.${field}.${language}`]
        });
      });
      return;
    }
    pushEntry(entries, {
      key: `common_answer.${field}`,
      label: field,
      value,
      category: "common_answer",
      aliases: [field],
      sourceFields: [`commonAnswers.${field}`]
    });
  });

  questionMemories
    .filter((memory) => stringValue(memory.answer))
    .slice(0, 120)
    .forEach((memory, index) => {
      const label = memory.displayQuestion || memory.contextPath || memory.question || `已学习答案 ${index + 1}`;
      pushEntry(entries, {
        key: `learned_answer.${index}`,
        label,
        value: memory.answer,
        language: memory.language,
        category: "learned_answer",
        aliases: [memory.question, memory.displayQuestion, memory.section, memory.group, memory.contextPath],
        sourceFields: ["questionMemory"]
      });
    });

  return normalizeProfileMemory({
    summary: buildLocalSummary(profile, entries),
    entries
  }, now);
}

export function mergeProfileMemoryWithQuestionMemories(profileMemory = {}, questionMemories = [], now = new Date().toISOString()) {
  const normalizedProfileMemory = normalizeProfileMemory(profileMemory, now);
  const learnedMemory = buildLocalProfileMemory({ questionMemories }, now);
  const learnedEntries = learnedMemory.entries.filter((entry) => entry.category === "learned_answer");
  const nonLearnedEntries = normalizedProfileMemory.entries.filter((entry) => entry.category !== "learned_answer");
  const summary = normalizedProfileMemory.summary || learnedMemory.summary;

  return normalizeProfileMemory({
    ...normalizedProfileMemory,
    summary,
    entries: [...nonLearnedEntries, ...learnedEntries]
  }, now);
}

export function normalizeProfileMemory(memory = {}, now = new Date().toISOString()) {
  const normalized = {
    summary: stringValue(memory.summary),
    entries: Array.isArray(memory.entries)
      ? memory.entries.map(normalizeEntry).filter((entry) => entry.key && entry.value)
      : [],
    updatedAt: now
  };
  const debug = normalizeDebug(memory.debug);
  if (debug) normalized.debug = debug;
  return normalized;
}

function normalizeEntry(entry) {
  return {
    key: stringValue(entry?.key),
    label: stringValue(entry?.label),
    value: stringValue(entry?.value),
    language: stringValue(entry?.language),
    category: stringValue(entry?.category),
    aliases: arrayOfStrings(entry?.aliases),
    sourceFields: arrayOfStrings(entry?.sourceFields)
  };
}

function addEducationEntries(entries, keyPrefix, zhTitle, enTitle, profile, fields) {
  const [universityZh, universityEn] = fields.university;
  const [degreeZh, degreeEn] = fields.degree;
  const [majorZh, majorEn] = fields.major;
  pushEntry(entries, {
    key: `education.${keyPrefix}.university.zh`,
    label: `${zhTitle}学校`,
    value: profile[universityZh],
    language: "zh",
    category: "education",
    aliases: ["学校名称", "中文学校", `${zhTitle}学校`],
    sourceFields: [universityZh]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.university.en`,
    label: `${enTitle} University`,
    value: profile[universityEn],
    language: "en",
    category: "education",
    aliases: ["University", "School name", `${enTitle} university`],
    sourceFields: [universityEn]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.degree.zh`,
    label: `${zhTitle}学历`,
    value: profile[degreeZh],
    language: "zh",
    category: "education",
    aliases: ["学历", "学历类型", `${zhTitle}学历`],
    sourceFields: [degreeZh]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.degree.en`,
    label: `${enTitle} Degree`,
    value: profile[degreeEn],
    language: "en",
    category: "education",
    aliases: ["Degree", "Education level", `${enTitle} degree`],
    sourceFields: [degreeEn]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.major.zh`,
    label: `${zhTitle}专业`,
    value: profile[majorZh],
    language: "zh",
    category: "education",
    aliases: ["专业", "所学专业", `${zhTitle}专业`],
    sourceFields: [majorZh]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.major.en`,
    label: `${enTitle} Major`,
    value: profile[majorEn],
    language: "en",
    category: "education",
    aliases: ["Major", "Subject", "Field of study", `${enTitle} major`],
    sourceFields: [majorEn]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.start_date`,
    label: `${zhTitle}入学时间`,
    value: profile[fields.startDate],
    category: "education",
    aliases: ["入学时间", "Start date", `${zhTitle}入学时间`],
    sourceFields: [fields.startDate]
  });
  pushEntry(entries, {
    key: `education.${keyPrefix}.graduation_date`,
    label: `${zhTitle}毕业时间`,
    value: profile[fields.graduationDate],
    category: "education",
    aliases: ["毕业时间", "Graduation date", `${zhTitle}毕业时间`],
    sourceFields: [fields.graduationDate]
  });
}

function addInternshipEntries(entries, internship = {}, index) {
  const prefix = `experience.internship.${index}`;
  pushEntry(entries, {
    key: `${prefix}.company.zh`,
    label: `实习 ${index + 1} 公司`,
    value: internship.companyZh,
    language: "zh",
    category: "experience",
    aliases: ["实习公司", "公司名称"],
    sourceFields: [`internships.${index}.companyZh`]
  });
  pushEntry(entries, {
    key: `${prefix}.company.en`,
    label: `Internship ${index + 1} Company`,
    value: internship.company,
    language: "en",
    category: "experience",
    aliases: ["Company", "Employer", "Internship company"],
    sourceFields: [`internships.${index}.company`]
  });
  pushEntry(entries, {
    key: `${prefix}.role.zh`,
    label: `实习 ${index + 1} 职位`,
    value: internship.roleZh,
    language: "zh",
    category: "experience",
    aliases: ["实习职位", "职位", "岗位"],
    sourceFields: [`internships.${index}.roleZh`]
  });
  pushEntry(entries, {
    key: `${prefix}.role.en`,
    label: `Internship ${index + 1} Role`,
    value: internship.role,
    language: "en",
    category: "experience",
    aliases: ["Role", "Position", "Job title"],
    sourceFields: [`internships.${index}.role`]
  });
  pushEntry(entries, {
    key: `${prefix}.period`,
    label: `实习 ${index + 1} 时间`,
    value: internship.period,
    category: "experience",
    aliases: ["实习时间", "工作时间", "Period", "Duration"],
    sourceFields: [`internships.${index}.period`]
  });
  pushEntry(entries, {
    key: `${prefix}.description.zh`,
    label: `实习 ${index + 1} 经历`,
    value: internship.descriptionZh,
    language: "zh",
    category: "experience",
    aliases: ["实习经历", "工作内容", "职责描述"],
    sourceFields: [`internships.${index}.descriptionZh`]
  });
  pushEntry(entries, {
    key: `${prefix}.description.en`,
    label: `Internship ${index + 1} Description`,
    value: internship.description,
    language: "en",
    category: "experience",
    aliases: ["Experience description", "Responsibilities", "Work description"],
    sourceFields: [`internships.${index}.description`]
  });
}

function buildLocalSummary(profile, entries) {
  const name = stringValue(profile.fullNameZh || profile.fullName || profile.englishName || "申请人");
  const categories = new Set(entries.map((entry) => entry.category).filter(Boolean));
  return `${name}的基础申请信息库，包含${Array.from(categories).join("、") || "个人资料"}等信息。`;
}

function pushEntry(entries, entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized.key || !normalized.value) return;
  entries.push(normalized);
}

function compactProfileForMemory(profile) {
  const compacted = {
    identity: pick(profile, ["fullNameZh", "fullName", "englishName"]),
    contact: pick(profile, ["phone", "email", "linkedin", "github", "website"]),
    education: {
      master: pick(profile, ["masterUniversity", "masterUniversityZh", "masterDegree", "masterDegreeZh", "masterMajor", "masterMajorZh", "masterStartDate", "masterGraduationDate"]),
      bachelor: pick(profile, ["bachelorUniversity", "bachelorUniversityZh", "bachelorDegree", "bachelorDegreeZh", "bachelorMajor", "bachelorMajorZh", "bachelorStartDate", "bachelorGraduationDate"])
    },
    internships: Array.isArray(profile.internships)
      ? profile.internships.map((item, index) => ({
        index,
        company: item.company,
        companyZh: item.companyZh,
        role: item.role,
        roleZh: item.roleZh,
        period: item.period,
        description: trimForAiContext(item.description, 1200),
        descriptionZh: trimForAiContext(item.descriptionZh, 1200)
      })).filter((item) => Object.values(item).some(Boolean))
      : [],
    commonAnswers: profile.commonAnswers || {}
  };
  return removeEmpty(compacted);
}

function pick(source, keys) {
  return Object.fromEntries(keys
    .map((key) => [key, stringValue(source?.[key])])
    .filter(([, value]) => Boolean(value)));
}

function removeEmpty(value) {
  if (Array.isArray(value)) return value.map(removeEmpty).filter((item) => Object.keys(item).length > 0);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, removeEmpty(item)])
    .filter(([, item]) => {
      if (Array.isArray(item)) return item.length > 0;
      if (item && typeof item === "object") return Object.keys(item).length > 0;
      return Boolean(item);
    }));
}

function parseJsonObject(text) {
  return parseJsonObjectWithDebug(text).value;
}

function parseJsonObjectWithDebug(text) {
  const cleaned = stringValue(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return { value: JSON.parse(cleaned), status: "ok" };
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { value: {}, status: "no-json-object" };
    try {
      return { value: JSON.parse(match[0]), status: "ok-with-extracted-object" };
    } catch {
      const salvaged = salvageProfileMemoryJson(cleaned);
      if (salvaged.entries.length) {
        return { value: salvaged, status: "salvaged-partial-json" };
      }
      return { value: {}, status: "invalid-json" };
    }
  }
}

function salvageProfileMemoryJson(text) {
  const summary = extractJsonStringProperty(text, "summary");
  const entriesStart = text.indexOf("\"entries\"");
  if (entriesStart === -1) return { summary, entries: [] };
  const arrayStart = text.indexOf("[", entriesStart);
  if (arrayStart === -1) return { summary, entries: [] };
  return {
    summary,
    entries: extractCompleteJsonObjects(text.slice(arrayStart + 1))
      .map((objectText) => {
        try {
          return JSON.parse(objectText);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  };
}

function extractCompleteJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function extractJsonStringProperty(text, property) {
  const marker = `"${property}"`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return "";
  const colonIndex = text.indexOf(":", markerIndex + marker.length);
  if (colonIndex === -1) return "";
  const firstQuoteIndex = text.indexOf("\"", colonIndex + 1);
  if (firstQuoteIndex === -1) return "";
  let escaped = false;
  for (let index = firstQuoteIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      try {
        return JSON.parse(text.slice(firstQuoteIndex, index + 1));
      } catch {
        return text.slice(firstQuoteIndex + 1, index);
      }
    }
  }
  return "";
}

function normalizeDebug(debug) {
  if (!debug || typeof debug !== "object") return null;
  const normalized = {
    parseStatus: stringValue(debug.parseStatus),
    rawTextPreview: trimForAiContext(debug.rawTextPreview, 1600),
    rawTextLength: Number.isFinite(Number(debug.rawTextLength)) ? Number(debug.rawTextLength) : 0
  };
  return normalized.parseStatus || normalized.rawTextPreview ? normalized : null;
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}
