import test from "node:test";
import assert from "node:assert/strict";
import { buildApplicationInfoGroups } from "../src/applicationInfo.js";
import { emptyProfile } from "../src/profile.js";

test("buildApplicationInfoGroups separates Chinese and English application info", () => {
  const groups = buildApplicationInfoGroups({
    ...emptyProfile(),
    fullNameZh: "李凯",
    fullName: "Kai Li",
    phone: "12345678",
    email: "kai@example.com",
    masterUniversityZh: "香港大学",
    masterUniversity: "The University of Hong Kong",
    masterDegreeZh: "硕士",
    masterDegree: "Master",
    masterMajorZh: "金融学",
    masterMajor: "Finance",
    masterStartDate: "2025-09",
    masterGraduationDate: "2026-06",
    bachelorUniversityZh: "中山大学",
    bachelorUniversity: "Sun Yat-sen University",
    bachelorDegreeZh: "本科",
    bachelorDegree: "Bachelor",
    bachelorMajorZh: "经济学",
    bachelorMajor: "Economics",
    bachelorStartDate: "2021-09",
    bachelorGraduationDate: "2025-06",
    internships: [
      {
        companyZh: "中金公司",
        company: "CICC",
        roleZh: "暑期分析师",
        role: "Summer Analyst",
        period: "2025.06 - 2025.08",
        descriptionZh: "制作市场更新材料。",
        description: "Built market update decks."
      }
    ]
  });

  assert.deepEqual(groups.map((group) => group.title), ["中文申请", "English Application"]);
  assert.deepEqual(groups[0].sections.map((section) => section.title), ["基础信息", "硕士教育", "本科教育", "实习经历"]);
  assert.deepEqual(groups[1].sections.map((section) => section.title), ["Basic Info", "Master Education", "Bachelor Education", "Internship Experience"]);

  const chineseBasic = groups[0].sections[0];
  assert.equal(chineseBasic.items.find((item) => item.label === "姓名").value, "李凯");
  assert.equal(chineseBasic.items.some((item) => item.value === "Kai Li"), false);

  const chineseInternship = groups[0].sections[3].entries[0];
  assert.equal(chineseInternship.items.find((item) => item.label === "职位").value, "暑期分析师");
  assert.equal(chineseInternship.items.find((item) => item.label === "经历").value, "制作市场更新材料。");
  assert.equal(chineseInternship.items.some((item) => item.value === "Summer Analyst"), false);

  const englishInternship = groups[1].sections[3].entries[0];
  assert.equal(englishInternship.items.find((item) => item.label === "Role").value, "Summer Analyst");
  assert.equal(englishInternship.items.find((item) => item.label === "Experience").value, "Built market update decks.");
  assert.equal(englishInternship.items.some((item) => item.value === "暑期分析师"), false);
});

test("buildApplicationInfoGroups does not put English-only values into the Chinese group", () => {
  const groups = buildApplicationInfoGroups({
    ...emptyProfile(),
    fullName: "Kai Li",
    masterUniversity: "The University of Hong Kong",
    internships: [
      {
        company: "CICC",
        role: "Summer Analyst",
        period: "2025.06 - 2025.08",
        description: "Built market update decks."
      }
    ]
  });

  const chineseGroup = groups.find((group) => group.title === "中文申请");
  const englishGroup = groups.find((group) => group.title === "English Application");

  assert.equal(chineseGroup, undefined);
  assert.ok(englishGroup);
  assert.equal(englishGroup.sections[0].items.find((item) => item.label === "Full Name").value, "Kai Li");
});
