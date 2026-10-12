// Chrome serializes this function for injection; keep every helper inside it.
export function collectJobSignals() {
  const clean = (value, max = 80) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const controls = "input,textarea,select,option,button,[contenteditable]:not([contenteditable='false']),[role='textbox']";
  const formArea = "form,[role='form'],.ant-form-item,.el-form-item,.ivu-form-item,.arco-form-item,.t-form__item,.layui-form-item,.form-group,.form-item--phoenix,[class*='apply-field'],[class*='aply-field']";
  const unique = (values) => [...new Set(values.filter(Boolean))].slice(0, 20);
  const visible = (element) => {
    if (!element || element.closest("[hidden],[aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
  };
  const safeText = (element) => {
    if (!visible(element) || element.closest(controls) || element.closest(formArea) || element.querySelector(controls)) return "";
    const text = clean(element.innerText ?? element.textContent, 1000);
    return text.length <= 80 ? text : "";
  };
  const textFrom = (selectors) => unique(selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map(safeText)));
  const meta = {};
  for (const key of ["og:title", "og:site_name", "twitter:title", "application-name"]) {
    meta[key] = clean(document.querySelector(`meta[property='${key}'],meta[name='${key}']`)?.getAttribute("content"), 240);
  }
  const signals = {
    jobPostings: [], meta, documentTitle: clean(document.title, 240),
    headings: [...textFrom(["h1"]).slice(0, 5), ...textFrom(["h2"]).slice(0, 5)],
    labels: { company: [], role: [], base: [] },
    classCandidates: { company: [], role: [], base: [] },
    breadcrumbs: textFrom(["nav[aria-label*='breadcrumb' i]", "[class*='breadcrumb']"]),
    logoAlts: unique([...document.querySelectorAll("header img[alt],[class*='logo'] img[alt]")]
      .filter((element) => visible(element) && !element.closest(formArea) && !element.closest(controls)).map((element) => clean(element.getAttribute("alt")))),
    hostname: location.hostname, pathname: location.pathname,
    siteCandidates: { company: [], role: [], base: [] }
  };
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12 || signals.jobPostings.length >= 30) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some((type) => /(?:^|[/#])JobPosting$/.test(type || ""))) {
      const locations = Array.isArray(value.jobLocation) ? value.jobLocation : [value.jobLocation];
      const places = unique(locations.map((item) => {
        const address = item?.address;
        if (typeof address === "string") return clean(address);
        return unique([clean(address?.addressRegion), clean(address?.addressLocality)]).join(" ");
      }));
      signals.jobPostings.push({ title: clean(value.title), company: clean(value.hiringOrganization?.name), base: clean(places.join(" / ")) });
    }
    Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
    try { visit(JSON.parse(script.textContent)); } catch { /* Invalid JSON-LD must not prevent other sources. */ }
  }
  const labels = {
    company: /^(?:公司名称|招聘单位|单位名称|企业名称|用人单位|所属公司|雇主|Company|Employer)\s*(?:[:：]\s*(.*))?$/i,
    role: /^(?:职位名称|岗位名称|招聘职位|应聘职位|申请职位|投递职位|应聘岗位|Position|Job title|Role)\s*(?:[:：]\s*(.*))?$/i,
    base: /^(?:工作地点|工作城市|办公地点|地点|Location|Address|Base)\s*(?:[:：]\s*(.*))?$/i
  };
  for (const element of document.querySelectorAll("dt,th,label,span,div,p,strong,b")) {
    const text = safeText(element);
    if (!text) continue;
    for (const [field, pattern] of Object.entries(labels)) {
      const match = pattern.exec(text);
      if (!match) continue;
      const value = clean(match[1]) || safeText(element.nextElementSibling) || safeText(element.parentElement?.nextElementSibling);
      if (value && value !== text) signals.labels[field].push(value);
    }
  }
  for (const field of Object.keys(signals.labels)) signals.labels[field] = unique(signals.labels[field]);
  signals.classCandidates.company = textFrom(["[class*='company-name']", "[class*='companyName']", "[class*='company_name']", "[class*='corp-name']", "[class*='employer']"]);
  signals.classCandidates.role = textFrom(["[class*='job-title']", "[class*='jobTitle']", "[class*='position-name']", "[class*='positionName']", "[class*='job-name']", "[class*='jobName']", "[class*='post-name']"]);
  signals.classCandidates.base = textFrom(["[class*='location']", "[class*='work-place']", "[class*='workCity']"]);

  if (/(^|\.)ctgoodjobs\.hk$/i.test(location.hostname)) {
    signals.siteCandidates.role = textFrom(["h1", "[class*='job'][class*='title']", ".job-title", "[data-testid*='title']"]);
    signals.siteCandidates.company = textFrom(["[class*='company'] a", "[class*='company']", ".company-name", "[data-testid*='company']"]);
    if (!signals.siteCandidates.company.length) {
      // Keep the site's near-heading fallback, but never inspect form answers.
      const heading = [...document.querySelectorAll("h1,[class*='job'][class*='title']")].find((element) => safeText(element) === signals.siteCandidates.role[0]);
      signals.siteCandidates.company = unique([safeText(heading?.nextElementSibling), safeText(heading?.parentElement?.nextElementSibling)]);
    }
    signals.siteCandidates.base = textFrom(["[class*='location']", "[class*='job-location']", "[data-testid*='location']"]);
  } else if (/(^|\.)jobsdb\.com$/i.test(location.hostname)) {
    signals.siteCandidates.role = textFrom(["[data-automation='job-detail-title']", "[data-automation*='job'][data-automation*='title']", "h1", "[class*='job'][class*='title']"]);
    signals.siteCandidates.company = textFrom(["[data-automation='advertiser-name']", "[data-automation*='company']", "[class*='company'] a", "[class*='company']"]);
    signals.siteCandidates.base = textFrom(["[data-automation='job-detail-location']", "[data-automation*='location']", "[class*='location']"]);
  } else if (/(^|\.)mokahr\.com$/i.test(location.hostname) || location.hostname === "job.swsmu.com") {
    const applicationRoles = textFrom([
      "[class*='application'] [class*='position-name']", "[class*='application'] [class*='positionName']",
      "[class*='application'] [class*='job-name']", "[class*='application'] [class*='job-title']",
      "[class*='apply-record'] [class*='title']", "[class*='application-record'] [class*='title']"
    ]);
    for (const label of document.querySelectorAll("span,div,p")) {
      if (!/^第\s*\d+\s*志愿$/.test(safeText(label))) continue;
      applicationRoles.push(safeText(label.nextElementSibling));
      for (const child of label.parentElement?.querySelectorAll("a,h1,h2,h3,h4,strong,b,span,p,div") || []) {
        if (!child.children.length) applicationRoles.push(safeText(child));
      }
    }
    const usefulApplicationRole = (value) => value.length >= 4 && !/^第\s*\d+\s*志愿$/.test(value)
      && !/^(?:校园|社会|校园招聘|社会招聘|校招|社招|投递记录|我的简历|状态|投递成功|项目|-)[:：]?$/i.test(value)
      && !/^(?:状态|项目)[:：]/.test(value) && !/[-–—]\s*(?:校园|社会)招聘$/.test(value);
    signals.siteCandidates.company = unique([...signals.classCandidates.company, ...textFrom(["[data-testid*='company']"]), meta["og:site_name"], ...signals.logoAlts]);
    signals.siteCandidates.role = unique([
      ...applicationRoles.filter(usefulApplicationRole), ...signals.classCandidates.role,
      ...textFrom(["[class*='position-title']", "[class*='positionTitle']", "[data-testid*='job-title']", "[data-testid*='position']"]),
      ...signals.headings
    ]);
    signals.siteCandidates.base = unique([...textFrom(["[class*='job-location']", "[class*='work-location']", "[class*='workLocation']", "[data-testid*='location']"]), ...signals.classCandidates.base]);
  }
  return signals;
}
