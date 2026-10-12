import test from "node:test";
import assert from "node:assert/strict";
import { buildApplicationInfoGroups } from "../src/applicationInfo.js";
import { emptyProfile, normalizeProfile } from "../src/profile.js";

test("normalizeProfile stores common application answers in Chinese and English", () => {
  const profile = normalizeProfile({
    commonAnswers: {
      visaSponsorship: { zh: " 不需要 ", en: " No " },
      rightToWork: { zh: " 有香港工作资格 ", en: " Authorized to work in Hong Kong " },
      expectedSalary: { zh: " 面议 ", en: " Negotiable " },
      earliestStartDate: { zh: " 2026-08 ", en: " August 2026 " },
      currentLocation: { zh: " 香港 ", en: " Hong Kong " },
      relocation: { zh: " 愿意 ", en: " Yes " },
      languageAbility: { zh: " 普通话、英语、粤语 ", en: " Mandarin, English, Cantonese " },
      whyRole: { zh: " 我对岗位感兴趣。 ", en: " I am interested in this role. " },
      whyCompany: { zh: " 我认可公司业务。 ", en: " I am interested in the company. " },
      selfIntroduction: { zh: " 我是金融学生。 ", en: " I am a finance student. " }
    }
  });

  assert.deepEqual(profile.commonAnswers.visaSponsorship, { zh: "不需要", en: "No" });
  assert.deepEqual(profile.commonAnswers.languageAbility, { zh: "普通话、英语、粤语", en: "Mandarin, English, Cantonese" });
});

test("emptyProfile includes empty common application answers", () => {
  const profile = emptyProfile();

  assert.equal(profile.commonAnswers.visaSponsorship.en, "");
  assert.equal(profile.commonAnswers.rightToWork.zh, "");
  assert.equal(profile.commonAnswers.selfIntroduction.en, "");
});

test("buildApplicationInfoGroups shows common answers in both language groups", () => {
  const groups = buildApplicationInfoGroups({
    ...emptyProfile(),
    commonAnswers: {
      visaSponsorship: { zh: "不需要", en: "No" },
      rightToWork: { zh: "有香港工作资格", en: "Authorized to work in Hong Kong" },
      expectedSalary: { zh: "面议", en: "Negotiable" }
    }
  });

  const chineseCommon = groups[0].sections.find((section) => section.title === "常见申请问题");
  const englishCommon = groups[1].sections.find((section) => section.title === "Common Application Questions");

  assert.equal(chineseCommon.items.find((item) => item.label === "是否需要签证赞助").value, "不需要");
  assert.equal(englishCommon.items.find((item) => item.label === "Visa Sponsorship").value, "No");
  assert.equal(englishCommon.items.find((item) => item.label === "Expected Salary").value, "Negotiable");
});
