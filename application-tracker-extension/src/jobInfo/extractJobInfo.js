const PLATFORMS = /^(?:智联招聘|智联|BOSS直聘|前程无忧|51job|猎聘|猎聘网|拉勾|拉勾招聘|实习僧|牛客|牛客网|应届生求职网|脉脉|LinkedIn|领英|JobsDB|CTgoodjobs|Indeed|Moka)$/i;
const GENERIC = /^(?:招聘|招聘官网|官方招聘网站|校园招聘|社会招聘|人才招聘|加入我们|Careers?|Jobs?|填写简历|简历填写|我的简历|职位详情|岗位详情|申请职位|职位申请|应聘职位|招聘职位|投递简历|个人中心|首页|登录|注册|校园|社会|校招|社招|投递记录|返回|基本信息|个人信息|个人基本信息|基础信息|教育经历|工作经历|Job details?|Job application|Apply(?: now)?|Save(?: job)?|Report|Share|Print|Company overview|Jobs? description)$/i;
const COMPANY = /公司|集团|银行|基金|证券|保险|科技|有限|股份|事务所|会计师|咨询|\b(?:Limited|Ltd\.?|Inc\.?|Group|Bank|Capital|Securities|LLP)\b/i;
const ROLE = /实习生|管培生|分析师|经理|专员|助理|工程师|会计|审计|顾问|主管|总监|培训生|研究员|\b(?:Intern|Analyst|Associate|Manager|Engineer|Accountant|Consultant|Specialist|Trainee|Graduate)\b/i;
const CITY = /^(?:北京|上海|广州|深圳|香港|杭州|南京|苏州|成都|武汉|西安|天津|重庆|厦门|珠海|东莞|佛山|长沙|郑州|济南|青岛|宁波|无锡|合肥|福州|沈阳|大连|昆明|南昌|南宁|海口|澳门)(?:市)?$|^(?:Hong Kong|Beijing|Shanghai|Shenzhen|Guangzhou)$/i;
const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const list = (value) => Array.isArray(value) ? value : value ? [value] : [];
const companyName = (value) => clean(value).replace(/(?:官方招聘网站|招聘官网|(?:校园|社会|人才|官方)?招聘|\s+Careers?|\s+Jobs?)$/i, "").trim();
const useful = (value) => value.length >= 2 && value.length <= 160 && !PLATFORMS.test(value) && !GENERIC.test(value) && !/^[-—–:：]+$/.test(value);
const titleParts = (value) => clean(value).split(/[_|｜\-\u2013\u2014·•丨\/]+|【|】|「|」|\[|\]/).map(clean).filter(useful);

export function extractJobInfo(signals = {}, { recentJobs = [] } = {}) {
  const result = { company: "", role: "", base: "", source: { company: "", role: "", base: "" }, confidence: { company: "", role: "", base: "" } };
  const valid = {
    company: (value) => useful(value) && !CITY.test(value) && (!ROLE.test(value) || COMPANY.test(value)),
    role: (value) => useful(value) && value !== result.company && !CITY.test(value) && (!COMPANY.test(value) || ROLE.test(value))
      && !/(?:招聘官网|官方招聘网站|校园招聘|社会招聘|人才招聘|\bCareers?)$/i.test(value),
    base: (value) => useful(value) && !/^(?:工作地点|工作城市|办公地点|地点|Location|Address|Base)[:：]?$/i.test(value)
  };
  const take = (field, values, source, confidence) => {
    if (result[field]) return;
    for (const raw of list(values)) {
      const value = field === "company" ? companyName(raw) : clean(raw);
      if (!valid[field](value)) continue;
      result[field] = value; result.source[field] = source; result.confidence[field] = confidence; break;
    }
  };
  for (const field of ["company", "role", "base"]) {
    take(field, list(signals.jobPostings).map((item) => item?.[field === "role" ? "title" : field]), "结构化数据", "high");
    take(field, signals.labels?.[field], "页面标签", "high");
    take(field, signals.siteCandidates?.[field], "页面标签", "high");
  }
  const meta = signals.meta || {};
  const siteName = companyName(meta["og:site_name"] || meta["application-name"]);
  const parts = [meta["og:title"], meta["twitter:title"], signals.documentTitle].flatMap(titleParts);
  const headings = list(signals.headings);
  take("company", [siteName, ...parts.filter((part) => COMPANY.test(companyName(part)) || companyName(part) === siteName),
    ...headings.filter((heading) => COMPANY.test(companyName(heading)) && !ROLE.test(heading))], "网页标题", "medium");
  take("role", [...headings.filter((heading) => ROLE.test(heading)), ...parts.filter((part) => ROLE.test(part)).map((part) => part.replace(/招聘$/, "").trim())], "网页标题", "medium");
  take("base", parts.filter((part) => CITY.test(part)), "网页标题", "medium");
  for (const field of ["company", "role", "base"]) take(field, signals.classCandidates?.[field], "页面文字", "low");
  take("company", signals.logoAlts, "页面文字", "low");
  // Recent jobs are offered by the popup for explicit selection, never silently
  // attributed to an application page that may belong to another vacancy.
  void recentJobs;
  return result;
}

export function sanitizeJobUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.search = ""; url.hash = ""; url.username = ""; url.password = "";
    return url.toString();
  } catch { return ""; }
}

export function sortRecentJobs(recentJobs = [], host = "") {
  const normalizedHost = clean(host).toLowerCase();
  const itemHost = (item) => {
    if (item.host) return clean(item.host).toLowerCase();
    try { return new URL(item.url).hostname.toLowerCase(); } catch { return ""; }
  };
  const time = (item) => typeof item.capturedAt === "number" ? item.capturedAt : Date.parse(item.capturedAt) || 0;
  return list(recentJobs).filter((item) => item && typeof item === "object").slice().sort((a, b) =>
    Number(itemHost(b) === normalizedHost) - Number(itemHost(a) === normalizedHost) || time(b) - time(a));
}
