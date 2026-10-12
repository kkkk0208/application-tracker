import { normalizeProfile } from "./profile.js";

const COMMON_ANSWER_LABELS = {
  visaSponsorship: { zh: "是否需要签证赞助", en: "Visa Sponsorship" },
  rightToWork: { zh: "工作资格", en: "Right to Work" },
  expectedSalary: { zh: "期望薪资", en: "Expected Salary" },
  earliestStartDate: { zh: "最早到岗时间", en: "Earliest Start Date" },
  currentLocation: { zh: "当前所在地", en: "Current Location" },
  relocation: { zh: "是否愿意搬迁", en: "Relocation" },
  languageAbility: { zh: "语言能力", en: "Language Ability" },
  whyRole: { zh: "为什么选择这个岗位", en: "Why This Role" },
  whyCompany: { zh: "为什么选择这家公司", en: "Why This Company" },
  selfIntroduction: { zh: "自我介绍", en: "Self Introduction" }
};

export function buildApplicationInfoGroups(profile) {
  const normalized = normalizeProfile(profile);
  return [
    buildChineseGroup(normalized),
    buildEnglishGroup(normalized)
  ].map((group) => ({
    ...group,
    sections: group.sections.filter((section) => hasSectionContent(section))
  })).filter((group) => group.sections.length > 0);
}

export function buildApplicationInfoSections(profile) {
  return buildApplicationInfoGroups(profile).flatMap((group) => group.sections);
}

function buildChineseGroup(profile) {
  return {
    title: "中文申请",
    sections: [
      buildSection("基础信息", [
        ["姓名", profile.fullNameZh],
        ["电话", profile.phone],
        ["邮箱", profile.email],
        ["LinkedIn", profile.linkedin],
        ["GitHub", profile.github],
        ["个人网站", profile.website]
      ]),
      buildSection("硕士教育", [
        ["学校", profile.masterUniversityZh],
        ["学历", profile.masterDegreeZh],
        ["专业", profile.masterMajorZh],
        ["入学时间", profile.masterStartDate],
        ["毕业时间", profile.masterGraduationDate]
      ]),
      buildSection("本科教育", [
        ["学校", profile.bachelorUniversityZh],
        ["学历", profile.bachelorDegreeZh],
        ["专业", profile.bachelorMajorZh],
        ["入学时间", profile.bachelorStartDate],
        ["毕业时间", profile.bachelorGraduationDate]
      ]),
      buildInternshipSection("实习经历", profile.internships, {
        company: "公司",
        role: "职位",
        period: "时间",
        description: "经历"
      }, "zh"),
      buildCommonAnswersSection("常见申请问题", profile.commonAnswers, "zh")
    ]
  };
}

function buildEnglishGroup(profile) {
  return {
    title: "English Application",
    sections: [
      buildSection("Basic Info", [
        ["Full Name", profile.fullName],
        ["English Name", profile.englishName],
        ["Phone", profile.phone],
        ["Email", profile.email],
        ["LinkedIn", profile.linkedin],
        ["GitHub", profile.github],
        ["Website", profile.website]
      ]),
      buildSection("Master Education", [
        ["University", profile.masterUniversity],
        ["Degree", profile.masterDegree],
        ["Major", profile.masterMajor],
        ["Start Date", profile.masterStartDate],
        ["Graduation Date", profile.masterGraduationDate]
      ]),
      buildSection("Bachelor Education", [
        ["University", profile.bachelorUniversity],
        ["Degree", profile.bachelorDegree],
        ["Major", profile.bachelorMajor],
        ["Start Date", profile.bachelorStartDate],
        ["Graduation Date", profile.bachelorGraduationDate]
      ]),
      buildInternshipSection("Internship Experience", profile.internships, {
        company: "Company",
        role: "Role",
        period: "Period",
        description: "Experience"
      }, "en"),
      buildCommonAnswersSection("Common Application Questions", profile.commonAnswers, "en")
    ]
  };
}

function buildSection(title, pairs) {
  return {
    title,
    items: pairs
      .filter(([, value]) => String(value || "").trim())
      .map(([label, value]) => ({ label, value, copyText: value })),
    entries: []
  };
}

function buildCommonAnswersSection(title, answers, language) {
  const pairs = Object.entries(COMMON_ANSWER_LABELS).map(([field, labels]) => [
    labels[language],
    answers[field]?.[language]
  ]);
  return buildSection(title, pairs);
}

function buildInternshipSection(title, internships, labels, language) {
  const entries = internships.map((internship) => {
    const company = language === "zh" ? internship.companyZh : internship.company;
    const role = language === "zh" ? internship.roleZh : internship.role;
    const description = language === "zh" ? internship.descriptionZh : internship.description;
    const hasLanguageSpecificContent = [company, role, description].some((value) => String(value || "").trim());
    if (!hasLanguageSpecificContent) return null;

    const items = [
      [labels.company, company],
      [labels.role, role],
      [labels.period, internship.period],
      [labels.description, description]
    ]
      .filter(([, value]) => String(value || "").trim())
      .map(([label, value]) => ({ label, value, copyText: value }));
    return {
      title: [company, role].filter(Boolean).join(" - "),
      items
    };
  }).filter((entry) => entry?.items.length > 0);

  return {
    title,
    items: [],
    entries
  };
}

function hasSectionContent(section) {
  return section.items.length > 0 || section.entries.length > 0;
}
