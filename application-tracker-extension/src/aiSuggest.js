export function buildAiSuggestionPayload({ model, question, language, profile = {}, memories = [] }) {
  return {
    model,
    input: [
      {
        role: "system",
        content: [
          "You help fill job application forms.",
          "Return only the answer text that can be pasted into the form.",
          "Do not explain. Do not add labels. If the available profile is not enough, return an empty string.",
          language === "zh" ? "Answer in Chinese." : "Answer in English."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          language,
          profile: compactProfile(profile, language),
          learnedAnswers: compactMemories(memories, language)
        })
      }
    ],
    max_output_tokens: 160
  };
}

export async function suggestApplicationAnswer(settings, context, fetchImpl = fetch) {
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
    body: JSON.stringify(buildAiSuggestionPayload({
      model: settings.model,
      ...context
    }))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `AI 请求失败 (${response.status})`);
  }
  return extractAiSuggestionText(data);
}

export function extractAiSuggestionText(data) {
  const direct = stringValue(data?.output_text);
  if (direct) return direct;

  const nested = Array.isArray(data?.output)
    ? data.output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((content) => stringValue(content?.text))
      .filter(Boolean)
      .join("\n")
    : "";
  return nested.trim();
}

export function trimForAiContext(value, maxLength = 500) {
  const text = stringValue(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}

function compactProfile(profile, language) {
  const suffix = language === "zh" ? "Zh" : "";
  const basic = {
    name: language === "zh" ? firstValue(profile.fullNameZh, profile.fullName, profile.englishName) : firstValue(profile.englishName, profile.fullName),
    phone: profile.phone,
    email: profile.email,
    linkedin: profile.linkedin,
    github: profile.github,
    website: profile.website
  };
  const education = [
    compactEducation("master", "Master", profile, suffix),
    compactEducation("bachelor", "Bachelor", profile, suffix)
  ].filter((item) => Object.values(item).some(Boolean));
  const internships = Array.isArray(profile.internships)
    ? profile.internships.slice(0, 6).map((item) => ({
      company: firstValue(language === "zh" ? item.companyZh : item.company, item.company, item.companyZh),
      role: firstValue(language === "zh" ? item.roleZh : item.role, item.role, item.roleZh),
      period: item.period,
      description: trimForAiContext(firstValue(language === "zh" ? item.descriptionZh : item.description, item.description, item.descriptionZh), 700)
    })).filter((item) => Object.values(item).some(Boolean))
    : [];
  return removeEmpty({
    basic,
    education,
    internships,
    commonAnswers: compactCommonAnswers(profile.commonAnswers, language)
  });
}

function compactEducation(prefix, label, profile, suffix) {
  return removeEmpty({
    level: label,
    university: firstValue(profile[`${prefix}University${suffix}`], profile[`${prefix}University`], profile[`${prefix}UniversityZh`]),
    degree: firstValue(profile[`${prefix}Degree${suffix}`], profile[`${prefix}Degree`], profile[`${prefix}DegreeZh`]),
    major: firstValue(profile[`${prefix}Major${suffix}`], profile[`${prefix}Major`], profile[`${prefix}MajorZh`]),
    startDate: profile[`${prefix}StartDate`],
    graduationDate: profile[`${prefix}GraduationDate`]
  });
}

function compactCommonAnswers(commonAnswers = {}, language) {
  return Object.fromEntries(Object.entries(commonAnswers)
    .map(([key, value]) => {
      const answer = value && typeof value === "object" ? value[language] : value;
      return [key, trimForAiContext(answer, 700)];
    })
    .filter(([, value]) => Boolean(value)));
}

function compactMemories(memories, language) {
  return memories
    .filter((memory) => !memory.language || memory.language === language)
    .slice(0, 12)
    .map((memory) => ({
      question: trimForAiContext(memory.question, 180),
      displayQuestion: trimForAiContext(memory.displayQuestion || memory.contextPath || memory.question, 220),
      contextPath: memory.contextPath || "",
      answer: trimForAiContext(memory.answer, 700)
    }))
    .filter((memory) => memory.question && memory.answer);
}

function removeEmpty(value) {
  if (Array.isArray(value)) return value.map(removeEmpty).filter((item) => Object.values(item).some(Boolean));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, removeEmpty(item)])
    .filter(([, item]) => {
      if (Array.isArray(item)) return item.length > 0;
      if (item && typeof item === "object") return Object.keys(item).length > 0;
      return Boolean(item);
    }));
}

function firstValue(...values) {
  return values.map(stringValue).find(Boolean) || "";
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}
