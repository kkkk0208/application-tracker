import test from "node:test";
import assert from "node:assert/strict";
import { extractJobInfo } from "../src/jobInfo/extractJobInfo.js";

const fields = (signals) => {
  const { company, role, base } = extractJobInfo(signals);
  return { company, role, base };
};

test("generic job extraction retains explicit Moka page candidates", () => {
  assert.deepEqual(fields({
    documentTitle: "职位申请",
    siteCandidates: {
      company: ["Acme Capital Limited"],
      role: ["Graduate Analyst"],
      base: ["Hong Kong"]
    }
  }), {
    company: "Acme Capital Limited",
    role: "Graduate Analyst",
    base: "Hong Kong"
  });
});

test("generic job extraction derives company from a Moka custom-domain recruitment title", () => {
  assert.deepEqual(fields({
    documentTitle: "申万菱信基金管理有限公司-招聘",
    headings: ["职位申请", "量化研究员"],
    siteCandidates: { base: ["上海市"] }
  }), {
    company: "申万菱信基金管理有限公司",
    role: "量化研究员",
    base: "上海市"
  });
});

test("generic job extraction ignores generic Moka headings", () => {
  assert.deepEqual(fields({
    documentTitle: "Moka",
    headings: ["职位详情", "申请职位"]
  }), {
    company: "",
    role: "",
    base: ""
  });
});

test("generic job extraction prefers a Moka candidate-center application role over campus navigation", () => {
  assert.deepEqual(fields({
    documentTitle: "中微公司 - 校园招聘",
    siteCandidates: { company: ["中微公司"], role: ["2027届-财务专员（上海）", "校园"] },
    headings: ["投递记录"]
  }), {
    company: "中微公司",
    role: "2027届-财务专员（上海）",
    base: ""
  });
});

test("generic job extraction does not turn Moka campus recruitment into a role", () => {
  assert.deepEqual(fields({
    documentTitle: "中微公司 - 校园招聘",
    siteCandidates: { company: ["中微公司"], role: ["校园", "校园招聘"] }
  }), {
    company: "中微公司",
    role: "",
    base: ""
  });
});
