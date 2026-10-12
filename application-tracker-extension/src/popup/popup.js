import { DEFAULT_SOURCE, DEFAULT_STATUS, SOURCES, STATUSES } from "../constants.js";
import { buildApplicationInfoGroups } from "../applicationInfo.js";
import { collectJobSignals } from "../jobInfo/collectSignals.js";
import { extractJobInfo, sortRecentJobs, sanitizeJobUrl } from "../jobInfo/extractJobInfo.js";
import { requestJobInfo } from "../jobInfo/aiJobInfo.js";
import { findPotentialDuplicate } from "../duplicates.js";
import { emptyRecordDraft, validateRecordForSave } from "../model.js";
import { detectSourceFromUrl } from "../sourceDetection.js";
import { getProfile, getRecords, saveNewRecord, getAiSettings } from "../storage.js";
import { toDateInputValue } from "../dateUtils.js";
import { scopeFor } from "../assistant/planner.js";

const form = document.querySelector("#applicationForm");
const tabWarning = document.querySelector("#tabWarning");
const saveMessage = document.querySelector("#saveMessage");
const formErrors = document.querySelector("#formErrors");
const autofillButton = document.querySelector("#autofillButton");
const autofillMessage = document.querySelector("#autofillMessage");
const recordPanel = document.querySelector("#recordPanel");
const applicationInfoPanel = document.querySelector("#applicationInfoPanel");
const applicationInfoList = document.querySelector("#applicationInfoList");
let activeApplicationLanguage = "zh";
let targetPageTab = null;
let draftKey;
let initialDraft;
let draftWrite = Promise.resolve();
const recentJobsKey = "applicationTracker.recentJobs";
const editedJobFields = new Set();
let jobInfo = null;
let initialJobInfo = null;
let signals = null;
let popupGeneration = 0;

init();

async function init() {
  fillSelect(form.elements.source, SOURCES, DEFAULT_SOURCE);
  fillSelect(form.elements.status, STATUSES, DEFAULT_STATUS);

  const draft = emptyRecordDraft();
  draft.source = DEFAULT_SOURCE;
  draft.appliedDate = toDateInputValue();

  try {
    const tab = await getTargetPageTab();
    targetPageTab = tab;
    draft.portalLink = tab?.url || "";
    draft.pageTitle = tab?.title || "";
    draft.source = detectSourceFromUrl(draft.portalLink);
    if (tab?.id) {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectJobSignals });
      signals = result?.result;
      if (signals) {
        jobInfo = extractJobInfo(signals);
        for (const key of ["company", "role", "base"]) draft[key] = jobInfo[key] || "";
        await rememberJob(jobInfo);
      }
    }
  } catch {
    tabWarning.hidden = false;
  }

  initialDraft = { ...draft };
  initialJobInfo = structuredClone(jobInfo);
  const identity = scopeFor(draft.portalLink) || "manual";
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  draftKey = `applicationTracker.popup.draft.${hash}`;
  const saved = (await chrome.storage.session.get(draftKey))[draftKey];
  if (saved?.draft) {
    Object.assign(draft, saved.draft);
    for (const key of ["company", "role", "base"]) if (draft[key] !== initialDraft[key]) editedJobFields.add(key);
    saveMessage.textContent = "已恢复此岗位的未保存草稿";
    saveMessage.hidden = false;
  }
  setFormValues(draft);
  renderSources();
  await renderRecentJobs();
  form.addEventListener("input", (event) => {
    const key = event.target.name;
    if (["company", "role", "base"].includes(key)) { editedJobFields.add(key); renderSources(); }
  });
  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);
  document.querySelector("#clearDraft").addEventListener("click", async () => {
    popupGeneration++;
    await draftWrite.catch(() => {});
    await chrome.storage.session.remove(draftKey);
    editedJobFields.clear();
    jobInfo = structuredClone(initialJobInfo);
    setFormValues(initialDraft);
    renderSources();
    saveMessage.textContent = "已清空草稿，保留网页预填信息";
    saveMessage.hidden = false;
  });
  form.addEventListener("submit", handleSubmit);
  void fillAiJobInfo();
  autofillButton.addEventListener("click", openAssistant);
  applicationInfoList.addEventListener("click", handleApplicationInfoClick);
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  document.querySelectorAll(".language-tab").forEach((button) => {
    button.addEventListener("click", () => switchApplicationLanguage(button.dataset.languageTab));
  });
}

function saveDraft() {
  if (!draftKey) return;
  // Dispatch immediately so closing the popup does not discard a debounce timer.
  draftWrite = chrome.storage.session.set({ [draftKey]: { draft: getFormValues(), updatedAt: Date.now() } });
  draftWrite.catch(() => { saveMessage.textContent = "草稿暂存失败，请先保存记录"; saveMessage.hidden = false; });
}

async function getTargetPageTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https?:\/\//.test(tab.url || "") ? tab : null;
}

function openAssistant() {
  if (!targetPageTab?.id) {
    autofillMessage.textContent = "请在申请网站中打开插件";
    autofillMessage.hidden = false;
    return;
  }
  const tab = targetPageTab;
  // Start open() in the click gesture; save the binding without delaying the gesture.
  Promise.all([
    chrome.storage.session.set({ [`applicationTracker.assistant.target.${tab.windowId}`]: tab.id }),
    chrome.sidePanel.open({ tabId: tab.id })
  ]).then(() => {
    autofillMessage.textContent = "已打开申请助手，请在侧栏核对填写";
    autofillMessage.hidden = false;
  }).catch(() => {
    autofillMessage.textContent = "无法打开侧栏，请刷新插件并使用 Chrome 120 或更新版本";
    autofillMessage.hidden = false;
  });
}

function isExtensionTab(tab) {
  return /^chrome-extension:\/\//i.test(tab?.url || "");
}

async function switchTab(tab) {
  const isApplicationInfo = tab === "applicationInfo";
  recordPanel.hidden = isApplicationInfo;
  applicationInfoPanel.hidden = !isApplicationInfo;
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (isApplicationInfo) {
    await renderApplicationInfo();
  }
}

async function renderApplicationInfo() {
  const groups = buildApplicationInfoGroups(await getProfile());
  const group = groups.find((item) => languageKeyForGroup(item) === activeApplicationLanguage) || groups[0];
  if (!group) {
    applicationInfoList.innerHTML = `
      <section class="application-info-empty">
        <p>还没有个人信息。</p>
        <a href="../profile/profile.html" target="_blank">去填写</a>
      </section>
    `;
    return;
  }
  applicationInfoList.innerHTML = renderApplicationInfoGroup(group);
}

function renderApplicationInfoGroup(group) {
  return `
    <section class="application-info-group">
      ${group.sections.map(renderApplicationInfoSection).join("")}
    </section>
  `;
}

async function switchApplicationLanguage(language) {
  activeApplicationLanguage = language;
  document.querySelectorAll(".language-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.languageTab === language);
  });
  await renderApplicationInfo();
}

function languageKeyForGroup(group) {
  return group.title === "English Application" ? "en" : "zh";
}
function renderApplicationInfoSection(section) {
  return `
    <section class="application-info-card">
      <header>
        <h2>${escapeHtml(section.title)}</h2>
      </header>
      ${renderApplicationInfoItems(section)}
    </section>
  `;
}

function renderApplicationInfoItems(section) {
  if (section.entries?.length) {
    return section.entries.map((entry) => `
      <div class="application-info-entry">
        <h3>${escapeHtml(entry.title || "实习经历")}</h3>
        <dl>
          ${entry.items.map(renderCopyableItem).join("")}
        </dl>
      </div>
    `).join("");
  }
  return `
    <dl>
      ${section.items.map(renderCopyableItem).join("")}
    </dl>
  `;
}

function renderCopyableItem(item) {
  return `
    <div>
      <dt>${escapeHtml(item.label)}</dt>
      <dd>${escapeHtml(item.value)}</dd>
      <button class="copy-item-button" type="button" data-action="copy-item" data-copy-text="${escapeAttribute(item.copyText || item.value)}">复制</button>
    </div>
  `;
}

async function handleApplicationInfoClick(event) {
  const button = event.target.closest("button[data-action='copy-item']");
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.copyText || "");
  autofillMessage.textContent = "已复制";
  autofillMessage.hidden = false;
}

function renderSources() {
  for (const key of ["company", "role", "base"]) {
    const label = document.querySelector('[data-job-source="' + key + '"]');
    label.textContent = !editedJobFields.has(key) && form.elements[key].value ? jobInfo?.source?.[key] || "" : "";
    label.hidden = !label.textContent;
  }
}

async function rememberJob(info) {
  if (!targetPageTab?.url) return;
  const trusted = (key) => ["high", "medium"].includes(info.confidence?.[key]) && info[key];
  if (!trusted("company") && !trusted("role")) return;
  const url = sanitizeJobUrl(targetPageTab.url);
  if (!url) return;
  const stored = (await chrome.storage.session.get(recentJobsKey))[recentJobsKey];
  const jobs = Array.isArray(stored) ? stored : [];
  const entry = { company: trusted("company") || "", role: trusted("role") || "", base: trusted("base") || "", url, host: new URL(url).hostname, capturedAt: Date.now(), source: info.source };
  await chrome.storage.session.set({ [recentJobsKey]: [entry, ...jobs.filter((job) => job.url !== url)].slice(0, 20) });
}

async function renderRecentJobs() {
  const box = document.querySelector("#recentJobBox");
  const select = document.querySelector("#recentJob");
  const stored = (await chrome.storage.session.get(recentJobsKey))[recentJobsKey];
  const jobs = sortRecentJobs(Array.isArray(stored) ? stored : [], signals?.hostname || "").filter((job) => job.role);
  box.hidden = !!jobInfo?.role || !jobs.length;
  select.replaceChildren(new Option("请选择最近识别的岗位", ""), ...jobs.map((job, index) => new Option([job.company, job.role, job.base].filter(Boolean).join(" · "), String(index))));
  select.onchange = () => {
    if (!select.value) return;
    const job = jobs[Number(select.value)];
    popupGeneration++;
    for (const key of ["company", "role", "base"]) { form.elements[key].value = job[key] || ""; editedJobFields.delete(key); }
    jobInfo = { ...job, source: { company: "最近岗位", role: "最近岗位", base: "最近岗位" } };
    renderSources();
    saveDraft();
  };
}

async function fillAiJobInfo() {
  const generation = popupGeneration;
  if (!signals || !["company", "role"].some((key) => !jobInfo?.[key] || jobInfo.confidence?.[key] === "low")) return;
  try {
    const result = await requestJobInfo(await getAiSettings(), signals);
    if (!result || generation !== popupGeneration) return;
    const source = { company: "AI 识别，请核对", role: "AI 识别，请核对", base: "AI 识别，请核对" };
    const confidence = Object.fromEntries(["company", "role", "base"].map((key) => [key, result.confidence]));
    for (const key of ["company", "role", "base"]) {
      if (!form.elements[key].value && !editedJobFields.has(key) && result[key]) {
        form.elements[key].value = result[key];
        jobInfo ||= { source: {}, confidence: {} };
        jobInfo[key] = result[key]; jobInfo.source[key] = source[key]; jobInfo.confidence[key] = confidence[key];
      }
    }
    renderSources();
    await rememberJob(jobInfo);
    if (generation === popupGeneration) saveDraft();
  } catch { /* Local extraction and manual entry remain available. */ }
}

async function handleSubmit(event) {
  event.preventDefault();
  popupGeneration++;
  hideMessages();

  const draft = getFormValues();
  const errors = validateRecordForSave(draft);
  if (Object.keys(errors).length > 0) {
    formErrors.innerHTML = Object.values(errors).map((error) => `<div>${escapeHtml(error)}</div>`).join("");
    formErrors.hidden = false;
    return;
  }

  try {
    const duplicate = findPotentialDuplicate(draft, await getRecords());
    if (duplicate && !confirm(buildDuplicateMessage(duplicate))) {
      return;
    }

    await saveNewRecord(draft);
    await draftWrite.catch(() => {});
    await chrome.storage.session.remove(draftKey);
    saveMessage.textContent = "已保存";
    saveMessage.hidden = false;
    form.reset();
    setFormValues({
      ...emptyRecordDraft(),
      source: DEFAULT_SOURCE,
      appliedDate: toDateInputValue(),
      status: DEFAULT_STATUS,
      portalLink: draft.portalLink,
      pageTitle: draft.pageTitle
    });
  } catch (error) {
    formErrors.textContent = `保存失败：${error.message}`;
    formErrors.hidden = false;
  }
}

function buildDuplicateMessage(duplicate) {
  const reason = duplicate.reason === "portalLink" ? "链接相同" : "公司和岗位相同";
  return `可能已记录过这条投递（${reason}）：${duplicate.record.company} - ${duplicate.record.role}\n\n仍然保存吗？`;
}

function fillSelect(select, options, selectedKey) {
  select.innerHTML = options
    .map((option) => `<option value="${option.key}">${option.label}</option>`)
    .join("");
  select.value = selectedKey;
}

function setFormValues(values) {
  for (const [key, value] of Object.entries(values)) {
    if (form.elements[key]) {
      form.elements[key].value = value;
    }
  }
}

function getFormValues() {
  return {
    company: form.elements.company.value,
    role: form.elements.role.value,
    base: form.elements.base.value,
    portalLink: form.elements.portalLink.value,
    pageTitle: form.elements.pageTitle.value,
    source: form.elements.source.value,
    appliedDate: form.elements.appliedDate.value,
    status: form.elements.status.value,
    nextActionDate: form.elements.nextActionDate.value,
    jdText: form.elements.jdText.value,
    notes: form.elements.notes.value
  };
}

function hideMessages() {
  saveMessage.hidden = true;
  autofillMessage.hidden = true;
  formErrors.hidden = true;
  formErrors.textContent = "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

