import { buildLocalProfileMemory } from "../aiProfileMemory.js";
import { optionMatch } from "./optionMatch.js";
import { dateFormatFor, formatDateValue, validateDateValue } from "./dateValue.js";

export const normalize = (v) => String(v ?? "").normalize("NFKC").replace(/[*＊:：]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export const MEMORY_SCOPE_VERSION = 2;
const privateParameter = (name) => /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|api[_-]?key|key|secret|password|session(?:id)?|session[_-]?id|sid|code|state|nonce)$/i.test(name) || /(?:^|[_-])(?:token|secret|password)$/i.test(name);
const trackingParameter = (name) => /^(?:utm_.+|gclid|fbclid|msclkid)$/i.test(name);
function scopedQuery(query) {
  const params = new URLSearchParams(query);
  for (const name of [...params.keys()]) if (privateParameter(name) || trackingParameter(name)) params.delete(name);
  params.sort();
  return params.size ? `?${params}` : "";
}
export function scopeFor(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    const hash = parsed.hash.slice(1);
    let route = "";
    // Preserve SPA routes and business hash parameters; ordinary scroll anchors
    // do not identify an application and may contain opaque access tokens.
    if (/^!?\//.test(hash)) {
      const queryAt = hash.indexOf("?");
      route = "#" + (queryAt < 0 ? hash : hash.slice(0, queryAt) + scopedQuery(hash.slice(queryAt + 1)));
    } else if (hash.includes("=")) {
      const query = scopedQuery(hash.replace(/^\?/, ""));
      if (query) route = "#" + query.slice(1);
    }
    return parsed.origin + parsed.pathname + scopedQuery(parsed.search) + route;
  } catch { return ""; }
}
export function memoryScopeMatches(memory, url) {
  if (memory.scope === "global") return true;
  const scope = scopeFor(url);
  // Older page scopes discarded job IDs. Require a fresh explicit confirmation
  // instead of silently treating an old path-only scope as a verified boundary.
  return memory.scopeVersion === MEMORY_SCOPE_VERSION && !!scope && memory.scope === scope;
}
export const versionOf = (profile) => {
  // Chrome storage and runtime messaging may serialize object keys in different orders.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
  const text = JSON.stringify(canonical(profile));
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
};
export function factsFromProfile(profile, language) {
  // Read only: do not save, normalize, migrate or regenerate the user's stored profile.
  return buildLocalProfileMemory({ profile }).entries.filter((e) => !e.language || e.language === language).map((e) => ({
    id: e.key, label: e.label, value: e.value, category: e.category,
    entityId: e.key.startsWith("education.") ? e.key.split(".").slice(0, 2).join(".") : e.key.startsWith("experience.") ? e.key.split(".").slice(0, 3).join(".") : "self",
    language: e.language, sourceFields: e.sourceFields
  }));
}
const rules = [
  ["contact.email", /^(e-?mail( address)?|电子邮箱|邮箱|电子邮件)$/i],
  ["contact.phone", /^(phone( number)?|mobile( number)?|telephone|手机(号码|号)?|联系电话|电话)$/i],
  ["contact.linkedin", /^(linkedin|linkedin (?:url|profile|profile url)|领英(?:链接|主页)?)$/i], ["contact.github", /^github$/i], ["contact.website", /^(website|portfolio|个人网站|作品集)$/i],
  ["identity.full_name", /^(full name|name|candidate name|applicant name|姓名|中文姓名|英文姓名|英文全名)$/i],
  ["identity.preferred_name", /^(preferred name|english name|英文名)$/i],
  ["university", /^(?:(?:本科|硕士|研究生|毕业|就读|在读)?(?:学校|院校)(?:名称)?|(?:name of (?:the )?)?(?:university|institution|school|college)(?: name)?)$/i],
  ["degree", /^(?:(?:最高|本科|硕士)?(?:学历|学位)|degree(?: type| level)?|education level)$/i], ["major", /^(?:(?:所学|主修)?专业(?:名称)?|主修|major|field of study)$/i],
  ["graduation_date", /^(?:(?:预计|预期)?毕业(?:日期|时间|年月)|(?:expected |anticipated )?(?:graduation|completion) date)$/i], ["start_date", /^(?:入学(?:日期|时间|年月)|开始(?:日期|时间)|start date|enrolment date|enrollment date)$/i],
  ["company", /^(公司|公司名称|实习公司|company|employer|company name)$/i], ["role", /^(职位|岗位|实习职位|role|position|job title)$/i],
  ["description", /^(实习经历|工作内容|职责描述|responsibilities|experience description|work description)$/i],
  ["period", /^(实习时间|工作时间|period|duration)$/i],
  ["common_answer.visaSponsorship", /^(?:是否需要签证担保|签证担保|visa sponsorship)$/i], ["common_answer.rightToWork", /^(?:工作资格|工作许可|right to work|work authorization)$/i],
  ["common_answer.expectedSalary", /^(?:期望薪资|期望薪酬|expected salary|salary expectation)$/i], ["common_answer.earliestStartDate", /^(?:最早到岗日期|到岗时间|earliest start date)$/i],
  ["common_answer.currentLocation", /^(?:现居住地|当前所在地|current location|current address)$/i], ["common_answer.relocation", /^(?:是否接受搬迁|是否接受异地工作|relocation)$/i],
  ["common_answer.languageAbility", /^(?:语言能力|英语水平|language ability|language proficiency)$/i],
  ["common_answer.whyRole", /^(?:为什么申请(?:这个|该|此)?(?:岗位|职位)|why this (?:role|position))\??$/i], ["common_answer.whyCompany", /^(?:为什么选择这家公司|为什么申请(?:这家|该|此)?公司|why this (?:company|firm))\??$/i],
  ["common_answer.selfIntroduction", /^(?:自我介绍|自我评价|introduce yourself|tell us about yourself|self.introduction)$/i],
  ["common_answer.visaSponsorship", /签证|sponsorship|\bvisa\b/i], ["common_answer.rightToWork", /工作资格|工作许可|right to work|authorized to work|work authorization/i],
  ["common_answer.expectedSalary", /期望薪资|薪酬|salary|compensation/i], ["common_answer.earliestStartDate", /到岗|入职|earliest start|notice period|available start/i],
  ["common_answer.currentLocation", /现居|当前所在地|current location|current address/i], ["common_answer.relocation", /搬迁|异地|relocat/i],
  ["common_answer.languageAbility", /语言能力|英语水平|language ability|language proficiency/i],
  ["common_answer.whyRole", /为什么.*岗位|为什么.*职位|why.*role|why.*position/i], ["common_answer.whyCompany", /为什么.*公司|why.*company|why.*firm/i],
  ["common_answer.selfIntroduction", /自我介绍|自我评价|introduce yourself|tell us about yourself|self.introduction/i]
];
const tentativeRules = [
  ["university", /学校|院校|university|institution|school|college/i],
  ["degree", /学历|学位|\bdegree\b|education level/i], ["major", /专业|主修|\bmajor\b|field of study/i],
  ["graduation_date", /毕业|graduation|completion date/i], ["start_date", /入学|start date|enrolment|enrollment/i]
];
export function intentFitsQuestion(field, intent) {
  const label = normalize(field.label);
  if (/\.(?:university|degree|major|graduation_date|start_date)$/.test(intent) && /所在地|地址|城市|国家|省份|排名|成绩|绩点|分数|编号|代码|是否|等级|address|location|city|country|province|rank|grade|gpa|score|number|code|whether/i.test(label)) return false;
  if (/父亲|father|母亲|mother|家属|family member|紧急联系人|emergency contact/i.test(label) && !field.entityId?.startsWith("family.")) return false;
  return true;
}
export function interpretField(field, fields = [], bindings = {}) {
  const label = normalize(field.label);
  const context = normalize(`${field.section} ${field.group}`);
  let entityId = "self";
  const subjectText = `${label} ${context}`;
  if (/父亲|father|母亲|mother|家庭|family|紧急联系人|emergency contact/.test(subjectText)) entityId = /父亲|father/.test(subjectText) ? "family.father" : /母亲|mother/.test(subjectText) ? "family.mother" : "family.unknown";
  const direct = rules.find(([, pattern]) => pattern.test(label));
  let intent = direct?.[0] || tentativeRules.find(([, pattern]) => pattern.test(label))?.[0] || "";
  let ruleConfidence = direct?.[1].source.startsWith("^") ? "high" : intent ? "low" : "none";
  if (/民族|ethnicity|出生|birth|身份证|national id|奖惩|处分|disciplin|award|证书|certificat|研究|research/.test(label)) intent = "";
  const education = /学校|教育|学历|本科|硕士|学士|education|bachelor|master|university|college/.test(context) || ["university", "degree", "major", "graduation_date"].includes(intent);
  const experience = /实习|工作经历|internship|work experience|employment/.test(context) || ["company", "role", "description", "period"].includes(intent);
  let visualGroupUnresolved = false;
  if (entityId === "self" && education) {
    const peers = fields.filter((f) => /学校|院校|university|institution|school/i.test(f.label));
    const degreeText = `${label} ${context}`;
    // A partial visual observation establishes only that field's degree level.
    // Do not mix it with default master's facts for unobserved sibling fields.
    const visualPeer = fields.some((f) => f.groupId === field.groupId && f.visualEvidence && /本科|学士|硕士|研究生|undergraduate|bachelor|postgraduate|master/i.test(`${f.label} ${f.section} ${f.group}`));
    visualGroupUnresolved = visualPeer && !/本科|学士|硕士|研究生|undergraduate|bachelor|postgraduate|master/.test(degreeText) && !bindings[field.groupId];
    entityId = /本科|学士|undergraduate|bachelor/.test(degreeText) ? "education.bachelor" : /硕士|研究生|postgraduate|master/.test(degreeText) ? "education.master" : visualGroupUnresolved ? "education.unknown" : new Set(peers.map((f) => f.groupId)).size <= 1 ? "education.master" : "education.unknown";
  } else if (entityId === "self" && experience) entityId = "experience.unknown";
  entityId = bindings[field.groupId] || entityId;
  if (["university", "degree", "major", "graduation_date", "start_date", "company", "role", "description", "period"].includes(intent)) intent = `${entityId}.${intent}`;
  if (intent && entityId.startsWith("family") && !intent.startsWith(`${entityId}.`)) intent = `${entityId}.${intent}`;
  if (!intentFitsQuestion({ ...field, entityId }, intent)) intent = "";
  if (field.contextConflicts?.length && !bindings[field.groupId]) ruleConfidence = "low";
  if (!intent) ruleConfidence = "none";
  return { intent, entityId, bindingExplicit: Boolean(bindings[field.groupId]), visualGroupUnresolved, ruleConfidence, needsSemanticReview: ruleConfidence !== "high", sensitive: /visa|rightToWork|Salary|earliestStartDate/.test(intent) || entityId.startsWith("family") || /证件|身份证|出生|民族|性别|national id|birth|ethnicity|gender/i.test(label), narrative: /whyRole|whyCompany|selfIntroduction|description/.test(intent) || field.kind === "textarea" };
}
export function validateValue(field, value) {
  if (!field.supported) return field.reason || "此字段暂不支持";
  if (typeof value !== "string" || !value.trim()) return "请补充答案";
  if (field.constraints?.maxLength && value.length > field.constraints.maxLength) return "答案超过网页字数限制";
  if (field.kind === "cascader") {
    let path;
    try { path = JSON.parse(value); } catch { return "请填写从上级到下级的选项路径数组"; }
    if (!Array.isArray(path) || !path.length || !path.every((part) => typeof part === "string" && part.trim())) return "请填写完整的级联选项路径";
  }
  if (field.options?.length && field.kind !== "cascader") {
    let values;
    try { values = field.constraints?.multiple ? JSON.parse(value) : [value]; } catch { return "请从选项中选择"; }
    if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length) return "选项格式不正确";
    if (values.some((v) => !optionMatch(field.options, v))) return "未找到唯一匹配选项";
  }
  if (field.kind === "date") return validateDateValue(field, value);
  if (field.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return "需要完整且有效的年月日";
  if (field.type === "month" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return "需要 YYYY-MM 格式";
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "邮箱格式不正确";
  if (field.type === "number" && (!Number.isFinite(Number(value)) || (field.constraints.min && Number(value) < Number(field.constraints.min)) || (field.constraints.max && Number(value) > Number(field.constraints.max)))) return "数值不在网页允许范围内";
  return "";
}
export function answerForFact(field, value) {
  let result = value;
  if (field.kind === "date" && !field.dateRange) {
    result = formatDateValue(value, dateFormatFor(field)) || value;
  } else if (field.datePart) {
    const match = String(value).match(/^(\d{4})[-./](\d{1,2})(?:[-./](\d{1,2}))?$/);
    if (!match) return "";
    const part = match[{ year: 1, month: 2, day: 3 }[field.datePart]];
    if (!part) return "";
    result = String(Number(part));
    const matches = field.options.filter((op) => !op.disabled && /^\d+[年月日]?$/.test(op.text) && Number(op.text.replace(/[年月日]/g, "")) === Number(part));
    if (matches.length === 1) result = matches[0].text;
  } else if (field.type === "month" && /^\d{4}[-./]\d{1,2}$/.test(value)) {
    const [year, month] = value.split(/[-./]/); result = `${year}-${month.padStart(2, "0")}`;
  }
  if (field.options?.length && !field.constraints?.multiple && field.kind !== "cascader") {
    const option = optionMatch(field.options, result);
    if (option) result = option.text;
  }
  return result;
}
export function preparePlan(snapshot, facts, memories = [], language = "zh", bindings = {}) {
  return snapshot.fields.map((field) => {
    const meaning = interpretField(field, snapshot.fields, bindings);
    const item = { ...field, ...meaning, answer: "", source: "", factIds: [], selected: false, status: !field.supported ? "unsupported" : field.value ? "filled" : "missing", reason: meaning.visualGroupUnresolved ? "截图仅确认了同组部分题目的学历，请核对此题或指定对应经历" : field.reason || "资料中没有明确答案" };
    if (!field.supported || field.value) return item;
    const matched = facts.filter((f) => !meaning.needsSemanticReview && meaning.intent && (f.id === meaning.intent || f.id === `${meaning.intent}.${language}`) && f.entityId === meaning.entityId);
    if (matched.length === 1) {
      const fact = matched[0];
      item.answer = answerForFact(field, fact.value);
      item.source = `个人信息 · ${fact.label}`;
      item.factIds = [fact.id];
      item.status = meaning.sensitive || meaning.narrative || field.kind === "custom-select" ? "review" : "ready";
      item.reason = meaning.entityId === "education.master" ? "使用硕士资料，请核对教育分组" : "来自现有个人信息";
    } else {
      const matches = memories.filter((m) => m.confirmed && m.language === language && m.entityId === meaning.entityId && normalize(m.question) === normalize(field.label) && memoryScopeMatches(m, snapshot.url));
      if (matches.length === 1) {
        item.answer = matches[0].answer;
        item.source = "已确认问答记忆";
        item.memoryId = matches[0].id;
        item.memoryVersion = matches[0].updatedAt;
        item.needsSemanticReview = false;
        item.status = "review";
        item.reason = "请核对答案是否仍适用于本次申请";
      } else if (matches.length > 1) item.reason = "记忆存在多个答案，请人工选择";
    }
    if (item.answer) {
      const error = validateValue(item, item.answer);
      if (error) { item.status = "review"; item.reason = error; }
      item.selected = item.status === "ready" && !error;
    }
    return item;
  });
}
export function eligibleFacts(item, facts) {
  if (item.entityId.includes("unknown") || item.needsSemanticReview) return [];
  return facts.filter((f) => {
    if (item.intent && f.entityId === item.entityId && (f.id === item.intent || f.id.startsWith(`${item.intent}.`))) return true;
    if (item.narrative && /whyRole|whyCompany|selfIntroduction/.test(item.intent)) return ["education", "experience"].includes(f.category);
    return item.narrative && /description/.test(item.intent) && f.entityId === item.entityId;
  });
}
export function acceptAiItems(raw, plan, facts) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const counts = new Map();
  for (const item of items) counts.set(item.fieldId, (counts.get(item.fieldId) || 0) + 1);
  const accepted = [];
  const errors = [];
  for (const proposal of items) {
    const item = plan.find((p) => p.fieldId === proposal.fieldId);
    const reject = (reason) => errors.push({ fieldId: proposal.fieldId, reason });
    if (!item || counts.get(proposal.fieldId) !== 1 || !item.supported || item.value || item.edited) { reject("字段未知、重复、已有内容或已被编辑"); continue; }
    const allowed = eligibleFacts(item, facts);
    if (proposal.entityId !== item.entityId || !Array.isArray(proposal.factIds) || !proposal.factIds.length || proposal.factIds.some((id) => !allowed.some((f) => f.id === id))) { reject("来源不足或主体不匹配"); continue; }
    let answer;
    if (proposal.kind === "fact") {
      if (proposal.factIds.length !== 1) { reject("直接事实必须引用唯一资料"); continue; }
      answer = answerForFact(item, allowed.find((f) => f.id === proposal.factIds[0]).value);
    } else if (proposal.kind === "option") {
      const option = item.options.find((op) => op.id === proposal.optionId && !op.disabled);
      if (!option || item.constraints.multiple) { reject("选项不存在或不是单选题"); continue; }
      answer = option.text;
    } else if (proposal.kind === "draft" && item.narrative) answer = proposal.text;
    else { reject("此字段不允许生成自由文本事实"); continue; }
    const error = validateValue(item, answer);
    if (error) { reject(error); continue; }
    accepted.push({ fieldId: item.fieldId, answer, factIds: proposal.factIds, status: "review", selected: false, source: "AI 草稿 · " + proposal.factIds.map((id) => facts.find((f) => f.id === id).label).join("、"), reason: "请核对后选中填写" });
  }
  return { accepted, errors };
}
