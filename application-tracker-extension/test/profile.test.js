import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyCommonAnswers,
  emptyProfile,
  normalizeProfile,
  profileHasUsableFields
} from "../src/profile.js";

test("normalizeProfile trims supported personal fields", () => {
  const profile = normalizeProfile({
    fullName: "  Kai Li  ",
    fullNameZh: " 李凯 ",
    englishName: " KL ",
    phone: " 12345678 ",
    email: " kai@example.com ",
    masterUniversity: " HKU ",
    masterUniversityZh: " 香港大学 ",
    masterDegree: " Master ",
    masterDegreeZh: " 硕士 ",
    masterMajor: " Finance ",
    masterStartDate: " 2025-09 ",
    masterGraduationDate: " 2026-06 ",
    bachelorUniversity: " CUHK ",
    bachelorUniversityZh: " 香港中文大学 ",
    bachelorDegree: " Bachelor ",
    bachelorMajor: " Economics ",
    bachelorStartDate: " 2021-09 ",
    bachelorGraduationDate: " 2025-06 ",
    internships: [
      {
        company: " CICC ",
        companyZh: " 中金公司 ",
        role: " Summer Analyst ",
        roleZh: " 暑期分析师 ",
        period: " 2025.06 - 2025.08 ",
        description: " Built market update decks. "
        ,descriptionZh: " 制作市场更新材料。 "
      },
      {
        company: "",
        role: "",
        period: "",
        description: ""
      }
    ],
    linkedin: " https://linkedin.com/in/kai ",
    github: " https://github.com/kai ",
    website: " https://kai.example.com "
  });

  assert.deepEqual(profile, {
    fullName: "Kai Li",
    fullNameZh: "李凯",
    englishName: "KL",
    phone: "12345678",
    email: "kai@example.com",
    masterUniversity: "HKU",
    masterUniversityZh: "香港大学",
    masterDegree: "Master",
    masterDegreeZh: "硕士",
    masterMajor: "Finance",
    masterMajorZh: "",
    masterStartDate: "2025-09",
    masterGraduationDate: "2026-06",
    bachelorUniversity: "CUHK",
    bachelorUniversityZh: "香港中文大学",
    bachelorDegree: "Bachelor",
    bachelorDegreeZh: "",
    bachelorMajor: "Economics",
    bachelorMajorZh: "",
    bachelorStartDate: "2021-09",
    bachelorGraduationDate: "2025-06",
    internships: [
      {
        company: "CICC",
        companyZh: "中金公司",
        role: "Summer Analyst",
        roleZh: "暑期分析师",
        period: "2025.06 - 2025.08",
        description: "Built market update decks.",
        descriptionZh: "制作市场更新材料。"
      }
    ],
    commonAnswers: emptyCommonAnswers(),
    linkedin: "https://linkedin.com/in/kai",
    github: "https://github.com/kai",
    website: "https://kai.example.com"
  });
});

test("emptyProfile returns every supported field as an empty string", () => {
  assert.deepEqual(emptyProfile(), {
    fullName: "",
    fullNameZh: "",
    englishName: "",
    phone: "",
    email: "",
    masterUniversity: "",
    masterUniversityZh: "",
    masterDegree: "",
    masterDegreeZh: "",
    masterMajor: "",
    masterMajorZh: "",
    masterStartDate: "",
    masterGraduationDate: "",
    bachelorUniversity: "",
    bachelorUniversityZh: "",
    bachelorDegree: "",
    bachelorDegreeZh: "",
    bachelorMajor: "",
    bachelorMajorZh: "",
    bachelorStartDate: "",
    bachelorGraduationDate: "",
    internships: [],
    commonAnswers: emptyCommonAnswers(),
    linkedin: "",
    github: "",
    website: ""
  });
});

test("normalizeProfile accepts legacy internship text and keeps usable entries", () => {
  const profile = normalizeProfile({
    internships: "CICC | Summer Analyst | 2025.06 - 2025.08 | Built dashboards"
  });

  assert.deepEqual(profile.internships, [
    {
      company: "CICC",
      companyZh: "",
      role: "Summer Analyst",
      roleZh: "",
      period: "2025.06 - 2025.08",
      description: "Built dashboards",
      descriptionZh: ""
    }
  ]);
});

test("normalizeProfile migrates legacy single education fields into master fields", () => {
  const profile = normalizeProfile({
    university: " HKU ",
    degree: " MSc ",
    major: " Finance ",
    graduationDate: " 2026-06 "
  });

  assert.equal(profile.masterUniversity, "HKU");
  assert.equal(profile.masterDegree, "MSc");
  assert.equal(profile.masterMajor, "Finance");
  assert.equal(profile.masterGraduationDate, "2026-06");
});

test("profileHasUsableFields detects whether autofill has anything to write", () => {
  assert.equal(profileHasUsableFields(emptyProfile()), false);
  assert.equal(profileHasUsableFields({ ...emptyProfile(), email: "kai@example.com" }), true);
});
