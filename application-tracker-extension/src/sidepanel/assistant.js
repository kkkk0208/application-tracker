import { getProfile, getAiSettings } from "../storage.js";
import { PROFILE_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY, STORAGE_KEY } from "../constants.js";
import { factsFromProfile, preparePlan, validateValue, versionOf, scopeFor } from "../assistant/planner.js";
import { buildDraftBatch, requestDraft, canDraftQuestion } from "../assistant/ai.js";
import { buildCatalog, pairingCandidates, requestPairing, acceptPairs } from "../assistant/aiPairing.js";
import { scanPage, checkTarget, fieldAction, pageChanges, inspectOptions } from "../assistant/session.js";
import { getMemories, saveMemory, loadSession, saveSession, MEMORY_KEY } from "../assistant/store.js";
import { reconcilePlan, entityLabel } from "../assistant/reconcile.js";
import { isFillable, finalizePreview, previewStats } from "../assistant/preview.js";
import { captureVisualContext } from "../assistant/visualCapture.js";
import { needsVisualRecognition, visionCandidates, requestVisualRecognition, applyVisualObservations, restoreVisualContext } from "../assistant/vision.js";
import { buildPanelView, detectPageLanguage } from "../assistant/panelView.js";
import { createRecordCard } from "./recordCard.js";

const $ = (id) => document.getElementById(id);
const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const labels = { ready: "已有明确答案", review: "请核对", missing: "缺资料", filled: "网页已有", unsupported: "在网页里处理" };
const panelGroups = ["attention", "ready", "web", "optional", "filled"];
let session = null;
let windowId;
let targetId;
let facts = [];
let busy = false;
let aborter;
let cancelled = false;
let learnItems = [];
let saves = Promise.resolve();
let draftConfirmation = null;
let requestToken = 0;
const owner = crypto.randomUUID();
const SESSION_VERSION = 7;
let renderedResultKey = "";
let pageAccessRecovery = null;
function clearPageAccessRecovery() {
  pageAccessRecovery = null;
  $("allowPageAccess").hidden = true;
}
const targetKey = () => `applicationTracker.assistant.target.${windowId}`;
const tell = (text) => { $("message").textContent = text; };
const recordCard = createRecordCard({
  container: $("recordCard"), getSession: () => session, persist, isBusy: () => busy || session?.stale,
  setBusy: (value) => setBusy(value, value ? "saving" : "review"), tell
});
function clearDraftConfirmation() {
  draftConfirmation = null;
  requestToken++;
}
function currentAiContext() {
  return { session, snapshot: session?.snapshot, tabId: targetId, profileVersion: session?.profileVersion,
    memoryVersion: session?.memoryVersion, settingsVersion: session?.settingsVersion, language: session?.language, token: requestToken };
}
function contextStillCurrent(context) {
  return !cancelled && !session?.stale && session === context.session && session?.snapshot === context.snapshot
    && targetId === context.tabId && session.language === context.language && requestToken === context.token;
}
async function verifyAiContext(context) {
  if (!contextStillCurrent(context)) throw new Error("页面或准备状态已变化，请重新识别后再确认");
  const [profile, memories, settings] = await Promise.all([getProfile(), getMemories(), getAiSettings()]);
  if (!contextStillCurrent(context)) throw new Error("页面或准备状态已变化，请重新识别后再确认");
  if (versionOf(profile) !== context.profileVersion || versionOf(memories) !== context.memoryVersion || versionOf(settings) !== context.settingsVersion) {
    session.stale = true; clearDraftConfirmation();
    throw new Error("个人资料、问答记忆或 AI 设置已更新，请重新识别后再确认");
  }
  let changes;
  try {
    await checkTarget(context.snapshot);
    changes = await pageChanges(context.snapshot);
  } catch (error) {
    if (contextStillCurrent(context)) { session.stale = true; clearDraftConfirmation(); }
    throw error;
  }
  if (!contextStillCurrent(context)) throw new Error("页面或准备状态已变化，请重新识别后再确认");
  if (changes.added || changes.changed.length) {
    session.stale = true; clearDraftConfirmation();
    throw new Error("网页表单已变化，请更新预览后重新确认");
  }
  return settings;
}
function canUndo(result) {
  if (result.undone || result.undoBlocked) return false;
  if (result.status === "verified") return true;
  // A changed value alone is not proof that it belongs to this operation.
  // The bridge must explicitly confirm ownership and exclude external edits.
  return result.status === "failed" && result.undoable === true
    && !["USER_EDITED", "VALUE_CHANGED"].includes(result.code)
    && typeof result.before === "string" && typeof result.after === "string"
    && result.before !== result.after;
}
function persist() {
  const value = structuredClone(session);
  saves = saves.catch(() => {}).then(() => saveSession(windowId, value));
  return saves;
}
function setBusy(value, phase = "review") {
  busy = value;
  if (session) session.phase = phase;
  for (const id of ["prepare", "useCurrent", "language", "learn", "refresh", "saveLearned", "saveResults", "selectAll", "clearSelection", "showAll", "allowPageAccess"]) $(id).disabled = value;
  document.querySelectorAll("[data-answer], [data-selected], [data-binding], [data-locate], [data-result-locate], [data-group-toggle], [data-learn-check], [data-learn-answer], [data-learn-scope], [data-frame-origin]").forEach((input) => { input.disabled = value || input.dataset.unavailable === "true"; });
  document.querySelectorAll("[data-draft], [data-draft-send], [data-draft-cancel]").forEach((input) => { input.disabled = value || session?.stale || input.dataset.draftUnavailable === "true"; });
  document.querySelectorAll("#recordCompany, #recordRole, #recordRecent, #saveRecord, #saveRecordAnyway").forEach((input) => { input.disabled = value || session?.stale; });
  $("cancel").hidden = !value || phase === "saving";
  $("cancel").disabled = false;
  refreshSummary();
}
function refreshSummary() {
  const plan = session?.plan || [];
  const stats = previewStats(plan);
  const view = buildPanelView(plan, session?.results || [], facts);
  const prepared = !!session?.snapshot && !session.stale;
  $(prepared ? "menu" : "start").appendChild($("prepare"));
  $("prepare").textContent = prepared ? "重新识别（放弃修改）" : "识别本页";
  $("prepare").classList.toggle("primary", !prepared);
  $("start").hidden = prepared;
  $("refresh").hidden = !prepared;
  $("refresh").textContent = "更新";
  $("fill").hidden = !prepared;
  $("fill").textContent = `填写 ${stats.selected} 项`;
  $("fill").disabled = busy || session?.stale || !stats.selected;
  $("selectAll").disabled = busy || session?.stale || !stats.eligible;
  $("clearSelection").disabled = busy || !stats.selected;
  $("undo").disabled = busy || session?.stale || !(session?.results || []).some(canUndo);
  $("countFill").textContent = `将填写 ${view.counts.fill}`;
  $("countAttention").textContent = `要你看 ${view.counts.attention}`;
  $("countSkip").textContent = `不填 ${view.counts.skip}`;
  $("showAll").hidden = !prepared || !plan.length;
  $("showAll").disabled = busy || session?.stale;
  $("showAll").textContent = session?.showAll ? "恢复默认收起" : "展开全部题目";
  document.querySelectorAll("[data-draft], [data-draft-send], [data-draft-cancel]").forEach((button) => { button.disabled = busy || session?.stale || button.dataset.draftUnavailable === "true"; });
}
function render() {
  $("targetTitle").textContent = session?.snapshot?.title || "在申请页面打开助手";
  $("targetUrl").textContent = session?.snapshot ? scopeFor(session.snapshot.url) : "";
  $("language").value = session?.languageChoice || session?.language || "zh";
  $("aiNote").hidden = !session?.aiEnabled;
  $("aiNote").textContent = session?.aiEnabled ? "文字配对只收到题目和资料目录名称，不收资料内容。写草稿需先确认发送相关资料；截图辅助的发送情况单独显示。" : "";
  $("overview").hidden = !session?.snapshot;
  $("visionStatus").hidden = !session?.visual?.message;
  $("visionStatus").textContent = session?.visual?.message || "";
  const pageType = session?.snapshot?.pageType;
  $("pageTypeNotice").hidden = !["job", "unknown"].includes(pageType);
  $("pageTypeNotice").textContent = pageType === "job" ? "当前页面像岗位详情页，已列出检测到的控件，请核对是否属于申请表。" : "尚未确定页面类型，已列出检测到的控件，请核对题目和答案。";
  const failedOrigins = [...new Set((session?.snapshot?.failedFrames || []).filter((frame) => frame.frameId !== 0 && /^https?:\/\//.test(frame.origin)).map((frame) => frame.origin))];
  $("framePermissions").hidden = !failedOrigins.length;
  $("framePermissions").innerHTML = failedOrigins.map((origin) => `<button type="button" data-frame-origin="${escape(origin)}" ${busy ? "disabled" : ""}>允许读取内嵌表单（${escape(new URL(origin).host)}）</button>`).join("");
  if (session?.snapshot) {
    const c = session.snapshot.coverage;
    $("coverage").textContent = `已检查 ${c.scanned}/${c.total} 个页面区域${c.failed || c.unknown ? "；有区域未检查，请在网页核对" : "；仅包含当前可见、可访问控件"}`;
    $("coverage").hidden = !c.failed && !c.unknown;
  } else {
    $("coverage").hidden = true;
  }
  const view = buildPanelView(session?.plan || [], session?.results || [], facts);
  const bindingGroups = new Set();
  const renderSegments = (items) => {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.groupId)) groups.set(item.groupId, []);
      groups.get(item.groupId).push(item);
    }
    return [...groups.entries()].map(([id, members]) => {
    const items = members;
    const name = [items[0].section, items[0].group].filter(Boolean).join(" / ") || "当前页面";
    const needsBinding = !bindingGroups.has(id) && items.some((p) => /^(education|experience)\./.test(p.entityId));
    if (needsBinding) bindingGroups.add(id);
    const entities = [...new Set(facts.filter((f) => /^(education|experience)\./.test(f.entityId)).map((f) => f.entityId))];
    const bindingName = (entity) => {
      const names = facts.filter((fact) => fact.entityId === entity && /\.(?:company|role|university)(?:\.(?:zh|en))?$/.test(fact.id)).map((fact) => fact.value).filter(Boolean);
      return [entityLabel(entity), ...new Set(names)].join(" · ");
    };
    const unresolved = items.some((p) => p.entityId.includes("unknown"));
    const bindingPrompt = items[0].entityId.startsWith("experience.") ? "请选择是哪段实习" : "请选择对应教育经历";
    const binding = needsBinding ? `<details class="binding" ${unresolved ? "open" : ""}><summary>对应：${escape(session.bindings?.[id] ? bindingName(session.bindings[id]) : entityLabel(items[0].entityId))}</summary><select aria-label="此分组对应的经历" data-binding="${escape(id)}" ${busy ? "disabled" : ""}><option value="">${unresolved ? bindingPrompt : "使用当前识别的对应经历"}</option>${entities.map((e) => `<option value="${escape(e)}" ${session.bindings?.[id] === e ? "selected" : ""}>${escape(bindingName(e))}</option>`).join("")}</select></details>` : "";
    return `<section class="subgroup"><div class="subgroup-header"><h3>${escape(name)}</h3>${binding}</div>${items.map(renderItem).join("")}</section>`;
    }).join("");
  };
  // Move the original buttons out before replacing their parent; listeners survive.
  $("start").appendChild($("selectionTools"));
  $("selectionTools").hidden = !previewStats(session?.plan || []).eligible;
  $("selectAll").textContent = "全选";
  $("clearSelection").textContent = "全不选";
  const titles = { attention: "要你看", ready: "将填写", web: "在网页里处理", optional: "其他选填", filled: "网页已有" };
  const openGroups = session?.openGroups || ["attention"];
  $("questions").innerHTML = panelGroups.map((group) => {
    const items = view.groups[group];
    if (!items.length) return "";
    const opened = openGroups.includes(group);
    const summary = group === "ready" ? view.readySections.slice(0, 3).map((part) => `${part.name} ${part.count}`).join(" · ") : group === "web" ? items.slice(0, 3).map((item) => item.label).join("、") : "";
    const rows = group === "attention" && items.length > 15 ? `${renderSegments(items.slice(0, 15))}<button class="text-button" data-more-toggle>${session?.attentionMore ? "收起更多题目" : `还有 ${items.length - 15} 题`}</button><div class="group-more" data-more ${session?.showAll || session?.attentionMore ? "" : "hidden"}>${renderSegments(items.slice(15))}</div>` : renderSegments(items);
    const selectionHeader = group === "ready" || group === "attention" && !view.groups.ready.length;
    return `<section class="group" data-group="${group}"><div class="group-header"><h2><button class="group-toggle" data-group-toggle="${group}" aria-expanded="${opened}" ${busy ? "disabled" : ""}>${titles[group]} ${items.length} 题 ${opened ? "▾" : "▸"}</button></h2>${selectionHeader ? '<span data-selection-slot></span>' : ""}</div>${summary ? `<p class="group-summary">${escape(summary)}</p>` : ""}<div class="group-body" ${opened ? "" : "hidden"}>${rows}</div></section>`;
  }).join("");
  const selectionSlot = $("questions").querySelector("[data-selection-slot]");
  if (selectionSlot) selectionSlot.appendChild($("selectionTools"));
  renderResults();
  refreshSummary();
}
function renderItem(item) {
  const unavailable = !!item.value || !item.supported;
  const unselectable = !isFillable(item);
  const disabled = busy ? "disabled" : "";
  let input;
  if (unavailable) input = `<p class="hint">${escape(item.value ? "网页已有内容，保留原值" : item.type === "file" ? "请在网页里上传" : /同意|agree|consent|条款|隐私/i.test(item.label + " " + (item.reason || "")) ? "请在网页里勾选同意" : "请在网页里处理")}</p>`;
  else if (item.options?.length && item.kind !== "cascader" && !item.dateRange) {
    let chosen;
    try { chosen = item.constraints.multiple ? JSON.parse(item.answer || "[]") : [item.answer]; } catch { chosen = []; }
    input = `<select class="answer" aria-label="${escape(item.label)}的答案" data-answer ${disabled} ${item.constraints.multiple ? "multiple" : ""}><option value="" ${item.constraints.multiple ? "disabled" : ""}>请选择</option>${item.options.filter((op) => !op.disabled).map((op) => `<option value="${escape(op.text)}" ${chosen.includes(op.text) ? "selected" : ""}>${escape(op.text)}</option>`).join("")}</select>`;
  } else if (item.narrative || item.kind === "textarea") input = `<textarea class="answer" data-answer ${disabled} rows="2" aria-label="${escape(item.label)}的答案" placeholder="补充本次答案">${escape(item.answer)}</textarea>`;
  else input = `<input class="answer" data-answer ${disabled} type="${!item.dateRange && item.kind !== "cascader" && ["date", "month", "email", "number"].includes(item.type) ? item.type : "text"}" aria-label="${escape(item.label)}的答案" placeholder="${item.dateRange ? '两个日期，如 [&quot;2022-09&quot;,&quot;2026-06&quot;]' : item.kind === "cascader" ? '路径，如 [&quot;广东省&quot;,&quot;深圳市&quot;]' : "补充本次答案"}" value="${escape(item.answer)}">`;
  const labelWarning = ["placeholder", "none"].includes(item.labelSource) ? '<span class="badge" data-label-warning>题目未识别</span>' : "";
  const draft = /AI\s*草稿/.test(item.source || "");
  const draftAvailable = session?.aiEnabled && canDraftQuestion(item);
  const draftHasFacts = draftAvailable && !!buildDraftBatch(item, facts, session.snapshot, session.language);
  const confirmation = draftConfirmation?.session === session && draftConfirmation.fieldId === item.fieldId ? draftConfirmation : null;
  const draftControls = draftAvailable ? `<button type="button" class="text-button" data-draft data-draft-unavailable="${!draftHasFacts}" ${busy || session.stale || !draftHasFacts ? "disabled" : ""}>AI 写草稿</button>${!draftHasFacts ? '<p class="hint">暂无可引用资料，请先补充个人信息。</p>' : ""}${confirmation ? `<div class="draft-confirmation" data-draft-confirmation><p class="hint">将发送：这道题、岗位描述，以及 ${confirmation.batch.facts.length} 项资料：${escape(confirmation.batch.facts.map((fact) => fact.label).join("、"))}</p><button type="button" data-draft-send ${busy || session.stale ? "disabled" : ""}>发送</button> <button type="button" data-draft-cancel ${busy || session.stale ? "disabled" : ""}>取消</button></div>` : ""}` : "";
  return `<article class="question ${item.status === "review" ? "needs-review" : ""} ${session?.sourceOpen?.includes(item.fieldId) ? "source-open" : ""}" data-id="${escape(item.fieldId)}"><div class="question-head">${unavailable ? "" : `<input aria-label="选中${escape(item.label)}" type="checkbox" data-selected data-unavailable="${unselectable}" ${item.selected ? "checked" : ""} ${unselectable || busy ? "disabled" : ""}>`}<label data-source-toggle role="button" tabindex="0">${escape(item.label)}${item.constraints.required ? " *" : ""}</label><span class="status ${item.status}" ${item.status === "review" || draft ? "" : "hidden"}>${draft ? "草稿" : labels[item.status]}</span>${labelWarning}<button data-locate ${disabled}>定位</button></div>${input}${draftControls}<p class="source">${escape(item.source || item.reason)}</p>${item.visualEvidence ? `<p class="source">截图辅助：${escape(item.visualEvidence)}</p>` : ""}${item.optionError ? `<p class="source">选项读取：${escape(item.optionError)}</p>` : ""}<p class="source" data-error>${escape(item.answer ? validateValue(item, item.answer) : "")}</p></article>`;
}
function renderResults() {
  const results = session?.results || [];
  $("results").hidden = !results.length;
  const verified = results.filter((r) => r.status === "verified" && !r.undone).length;
  const undone = results.filter((r) => r.undone).length;
  const failedChanges = results.filter((r) => r.status === "failed" && canUndo(r)).length;
  $("saveResults").hidden = !verified;
  $("saveResults").disabled = busy;
  const failed = results.filter((r) => r.status !== "verified" && !r.undone).length;
  const uniqueVerified = new Set(results.filter((r) => r.status === "verified" && !r.undone).map((r) => r.fieldId)).size;
  $("saveResults").textContent = `保存 ${uniqueVerified} 个答案，下次直接用`;
  $("resultSummary").textContent = `已填好 ${verified}/${results.length} 项${failed ? `，${failed} 项没填上` : ""}${undone ? `，已撤销 ${undone} 项` : ""}${failedChanges ? ` · 写入失败但可撤销 ${failedChanges} 项` : ""}`;
  const reasons = { VERIFIED: "已填好", VALUE_NOT_RETAINED: "网站没有保存这个值，请手动检查", USER_EDITED: "你改过这一项，已保留你的内容", FIELD_CHANGED: "页面变了，请点“更新”", OPTIONS_CHANGED: "页面变了，请点“更新”", DATE_UNSUPPORTED: "这个日期要在网页里手动选" };
  const row = (r) => `<div class="result-row ${r.status === "verified" && !r.undone ? "success" : ""}"><strong>${escape(r.label || session.plan.find((p) => p.fieldId === r.fieldId)?.label || "字段")}</strong><p>${escape(r.undone ? "已撤销" : r.undoReason ? `撤销未完成：${r.undoReason}` : reasons[r.code] || r.reason)}</p>${r.status !== "verified" && !r.undone ? `<button data-result-locate="${escape(r.fieldId)}" ${busy ? "disabled" : ""}>去网页看</button>` : ""}</div>`;
  const done = results.filter((r) => r.status === "verified" && !r.undone);
  $("resultList").innerHTML = `${results.filter((r) => r.status !== "verified" || r.undone).map(row).join("")}${done.length ? `<details id="resultDone"><summary>已填好 ${done.length} 项</summary>${done.map(row).join("")}</details>` : ""}`;
  const resultKey = JSON.stringify(results.map((r) => [r.operationId, r.status, r.undone, r.undoReason]));
  if (results.length && resultKey !== renderedResultKey) window.scrollTo({ top: 0, behavior: "smooth" });
  renderedResultKey = resultKey;
  void recordCard.render();
}
async function bindCurrent() {
  clearPageAccessRecovery();
  recordCard.cancel();
  clearDraftConfirmation();
  aborter?.abort();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!/^https?:\/\//.test(tab?.url || "")) throw new Error("请切换到申请网站，再点击改为当前页面");
  targetId = tab.id;
  session = { tabId: targetId, language: $("language").value, languageExplicit: session?.languageExplicit === true, plan: [], bindings: {}, results: [], openGroups: ["attention"], phase: "idle" };
  await chrome.storage.session.set({ [targetKey()]: targetId });
  await persist();
  render();
  $("targetTitle").textContent = tab.title;
  $("targetUrl").textContent = scopeFor(tab.url);
  await tabNotice();
  setBusy(false);
  tell("打开网申页后，点“识别本页”。");
}
async function prepare(learning = false, preserve = false) {
  if (busy) return;
  clearPageAccessRecovery();
  recordCard.cancel();
  clearDraftConfirmation();
  if (!targetId) await bindCurrent();
  const scannedTabId = targetId;
  const prepareToken = requestToken;
  const originalSession = session;
  cancelled = false;
  aborter = new AbortController();
  $("aiNote").hidden = true;
  $("aiNote").textContent = "";
  setBusy(true, "scanning");
  tell("正在识别当前页面的分区、问题与控件…");
  let previousChoices = [];
  let previewReady = false;
  let preparedSession = null;
  try {
    const previous = session;
    const [snapshot, profile, memories, settings] = await Promise.all([scanPage(targetId), getProfile(), getMemories(), getAiSettings()]);
    if (cancelled || requestToken !== prepareToken || targetId !== scannedTabId) return;
    const language = previous?.languageExplicit ? $("language").value : detectPageLanguage(snapshot);
    $("language").value = language;
    facts = factsFromProfile(profile, language);
    const sameDocuments = preserve && previous?.snapshot?.url === snapshot.url && JSON.stringify(previous.snapshot.frames.map((f) => f.documentId)) === JSON.stringify(snapshot.frames.map((f) => f.documentId));
    const bindings = sameDocuments ? previous.bindings || {} : {};
    session = { schemaVersion: SESSION_VERSION, tabId: targetId, snapshot, language, languageExplicit: previous?.languageExplicit === true, profileVersion: versionOf(profile), memoryVersion: versionOf(memories), settingsVersion: versionOf(settings), aiEnabled: settings.enabled && !!settings.apiKey, bindings, results: sameDocuments ? previous.results || [] : [], openGroups: sameDocuments ? previous.openGroups || ["attention"] : ["attention"], showAll: sameDocuments && previous.showAll === true, attentionMore: sameDocuments && previous.attentionMore === true, plan: preparePlan(snapshot, facts, memories, language, bindings), phase: "review", stale: false };
    if (sameDocuments) for (const key of ["recordDraft", "recordEdited", "recentJobs", "recordSaved", "recordInfo", "recordError"]) {
      if (Object.hasOwn(previous, key)) session[key] = structuredClone(previous[key]);
    }
    preparedSession = session;
    if (snapshot.pageType === "login") {
      session.plan = session.plan.map((p) => ({ ...p, supported: false, selected: false, status: "unsupported", reason: "请先完成登录或身份验证" }));
      tell("请在网站完成登录或验证后重新识别。");
      render(); await persist(); return;
    }
    if (!learning) void recordCard.prepare(snapshot, settings);
    render(); await persist();
    if (learning) { showLearning(session.plan.filter((p) => p.supported && p.value).map((p) => ({ ...p, answer: p.value }))); tell("请核对读取到的答案与适用范围，再保存。"); return; }
    const errors = [];
    // Discover what the site actually offers before asking the model to select an answer.
    const selects = session.plan.filter((p) => p.supported && !p.value && p.kind === "custom-select");
    const optionErrors = new Map();
    for (let i = 0; i < selects.length; i++) {
      if (cancelled || session.stale) break;
      tell(`正在读取网页选项 ${i + 1}/${selects.length}：${selects[i].label}`);
      try {
        let result = await inspectOptions(snapshot, selects[i]);
        const candidate = selects[i];
        const query = candidate.ruleConfidence === "high" && /\.(university|major|company)(?:\.(zh|en))?$/.test(candidate.intent) && candidate.source.startsWith("个人信息") && candidate.answer?.length <= 120 ? candidate.answer : "";
        if (!cancelled && !session.stale && query && result.restored === true && (result.code === "OPTIONS_TIMEOUT" || result.status === "inspected" && !result.options?.length)) {
          result = await inspectOptions(snapshot, candidate, { query });
        }
        if (result.status !== "inspected") optionErrors.set(selects[i].fieldId, result.reason || "无法安全读取选项，请在网站核对");
      } catch (error) { optionErrors.set(selects[i].fieldId, error.message); }
    }
    session.plan = preparePlan(snapshot, facts, memories, language, bindings).map((item) => ({ ...item, optionError: optionErrors.get(item.fieldId) || "" }));
    if (sameDocuments && previous.language === language && restoreVisualContext(snapshot, previous.plan, session.plan)) {
      session.plan = preparePlan(snapshot, facts, memories, language, bindings).map((item) => ({ ...item, optionError: optionErrors.get(item.fieldId) || "" }));
    }
    if (sameDocuments && previous.language === language && previous.profileVersion === session.profileVersion && previous.memoryVersion === session.memoryVersion) {
      session.plan = reconcilePlan(previous.plan, session.plan);
      previousChoices = previous.plan;
    }
    previewReady = true;
    render(); await persist();
    if (cancelled || session.stale) return;
    if (settings.visionEnabled) {
      if (!settings.enabled || !settings.apiKey) session.visual = { status: "disabled", message: "截图辅助未运行：请在 AI 设置中启用 AI 并保存 API Key。" };
      else if (!session.plan.some(needsVisualRecognition)) session.visual = { status: "skipped", message: "当前题目已有可用答案或人工指定的结果，无需发送截图。" };
      else {
        let capture;
        try {
          tell("正在读取当前可见区域，遮盖输入控件后进行截图辅助识别…");
          capture = await captureVisualContext(snapshot, { signal: aborter.signal });
          if (cancelled || session.stale) return;
          if (!visionCandidates(session.plan, capture).length) session.visual = { status: "skipped", message: "当前可见区域没有待视觉识别的字段；可滚动到疑难题后更新预览。" };
          else {
            session.visual = { status: "sending", message: "本次将发送当前可见区域的遮盖截图；仅用于题目与分区识别，不存入本地记录。" };
            render();
            const observations = await requestVisualRecognition(settings, session.plan, capture, aborter.signal);
            if (cancelled || session.stale) return;
            await checkTarget(snapshot);
            const changes = await pageChanges(snapshot);
            if (changes.added || changes.changed.length) throw new Error("截图分析期间表单发生变化，本次视觉结果已放弃，请更新预览");
            const result = applyVisualObservations(snapshot, session.plan, observations);
            const count = result.applied + result.evidenceOnly;
            if (count) {
              session.plan = reconcilePlan(session.plan, preparePlan(snapshot, facts, memories, language, bindings).map((item) => ({ ...item, optionError: optionErrors.get(item.fieldId) || "" })));
              if (previousChoices.length) session.plan = reconcilePlan(previousChoices, session.plan);
            }
            session.visual = { status: "used", count, message: `已发送当前可见区域的遮盖截图，辅助识别 ${count} 项。请核对标有“截图辅助”的题目；截图不存入本地记录。` };
          }
        } catch (error) {
          if (cancelled || aborter.signal.aborted) return;
          session.visual = { status: "fallback", message: `截图辅助未完成，继续使用文字识别：${error.message}` };
        } finally { capture = null; }
      }
      render(); await persist();
    }
    if (cancelled || session.stale) return;
    if (settings.enabled && settings.apiKey) {
      const context = currentAiContext();
      const catalog = buildCatalog(facts, memories, snapshot.url, language);
      const candidates = pairingCandidates(session.plan);
      setBusy(true, "preparing");
      for (let i = 0; i < candidates.length; i += 30) {
        if (cancelled || session.stale) break;
        const batch = candidates.slice(i, i + 30);
        tell(`AI 正在配对题目 ${i + 1}–${Math.min(i + 30, candidates.length)}/${candidates.length}…`);
        try {
          await verifyAiContext(context);
          const raw = await requestPairing(settings, batch, catalog, language, aborter.signal);
          if (!contextStillCurrent(context)) break;
          await verifyAiContext(context);
          const response = acceptPairs(raw, session.plan, facts, memories, { url: snapshot.url, language, batchIds: new Set(batch.map((item) => item.fieldId)) });
          for (const update of response.accepted) {
            const item = session.plan.find((candidate) => candidate.fieldId === update.fieldId);
            if (item && !item.edited) Object.assign(item, update);
          }
          if (response.errors.length) errors.push(`${response.errors.length} 项配对未通过校验`);
          render(); await persist();
        } catch (error) { if (!cancelled) errors.push(error.name === "TimeoutError" ? "AI 请求超时" : error.message); }
      }
    }
    tell(session.stale ? "个人资料或目标页面已变化，请重新识别。" : cancelled ? "已停止 AI 准备，保留已得到的结果。" : errors.length ? `已有答案可预览确认；${errors.join("；")}` : "看一下“要你看”里的题，然后点“填写”。");
  } catch (error) {
    if (cancelled || requestToken !== prepareToken || targetId !== scannedTabId) return;
    if (!previewReady && session === originalSession && session?.snapshot) session.stale = true;
    throw error;
  } finally {
    if (session === preparedSession || !preparedSession && session === originalSession) {
      if (previewReady && !session.stale) session.plan = finalizePreview(session.plan.map((item) => item.visualEvidence && !item.value && item.answer ? { ...item, status: "review" } : item), previousChoices);
      setBusy(false); render(); if (session) await persist();
    }
  }
}
async function confirmDraft(item) {
  if (busy || !session?.aiEnabled || !session.snapshot || session.stale) return;
  clearDraftConfirmation();
  cancelled = false;
  const context = currentAiContext();
  setBusy(true, "confirming");
  try {
    await verifyAiContext(context);
    const batch = buildDraftBatch(item, facts, context.snapshot, context.language);
    if (!contextStillCurrent(context) || !batch || !session.plan.includes(item)) return;
    // This batch contains applicant values, so it must remain memory-only.
    // persist() deliberately clones only session, never this confirmation.
    draftConfirmation = { ...context, fieldId: item.fieldId, batch };
    tell("核对这一题将发送的资料，点“发送”后才会生成草稿。");
  } finally {
    if (session === context.session) { setBusy(false); render(); await persist(); }
  }
}
async function sendDraft(item) {
  const confirmation = draftConfirmation;
  if (busy || !confirmation || session?.stale || confirmation.session !== session || confirmation.fieldId !== item.fieldId) return;
  cancelled = false;
  aborter = new AbortController();
  setBusy(true, "drafting");
  try {
    const settings = await verifyAiContext(confirmation);
    if (draftConfirmation !== confirmation) return;
    const currentBatch = buildDraftBatch(item, facts, confirmation.snapshot, confirmation.language);
    if (!currentBatch || JSON.stringify(currentBatch) !== JSON.stringify(confirmation.batch)) {
      clearDraftConfirmation(); throw new Error("这一题或资料已变化，请重新打开草稿确认框");
    }
    const previousChoice = structuredClone(item);
    tell("正在为这一题生成草稿…");
    const response = await requestDraft(settings, confirmation.batch, item, facts, aborter.signal);
    if (!contextStillCurrent(confirmation) || draftConfirmation !== confirmation) return;
    await verifyAiContext(confirmation);
    if (!contextStillCurrent(confirmation) || !session.plan.includes(item)) return;
    const update = response.accepted.find((entry) => entry.fieldId === item.fieldId);
    if (update) {
      const index = session.plan.indexOf(item);
      session.plan[index] = finalizePreview([{ ...item, ...update, edited: false, memoryId: null, memoryVersion: null,
        selectionExplicit: previousChoice.selectionExplicit, selected: previousChoice.selected }], [previousChoice])[0];
      tell("草稿已准备好，请核对后再填写。");
    } else tell(response.errors.length ? `草稿未通过校验，已保留原答案：${response.errors.map((entry) => entry.reason).join("；")}` : "AI 未提供可用草稿，已保留原答案。");
  } catch (error) {
    if (!cancelled) tell(error.name === "TimeoutError" ? "AI 请求超时，已保留原答案。" : `${error.message}；已保留原答案。`);
  } finally {
    if (draftConfirmation === confirmation) clearDraftConfirmation();
    if (session === confirmation.session) { setBusy(false); render(); await persist(); }
  }
}
async function fillSelected(undo = false) {
  if (busy || !session?.snapshot || session.stale) return;
  clearDraftConfirmation();
  cancelled = false;
  setBusy(true, "filling");
  let acquired = false;
  let needsRefresh = false;
  try {
  const profileVersion = versionOf(await getProfile());
  if (cancelled) return;
  if (profileVersion !== session.profileVersion) { session.stale = true; render(); throw new Error("个人资料已更新，请重新识别"); }
  const memoryVersion = versionOf(await getMemories());
  if (cancelled) return;
  if (memoryVersion !== session.memoryVersion) { session.stale = true; render(); throw new Error("问答记忆已更新，请更新问题后再核对填写"); }
  const work = undo ? session.results.filter(canUndo).slice().reverse() : session.plan.filter((p) => p.selected && isFillable(p));
  if (!work.length) return;
  const lock = await chrome.runtime.sendMessage({ type: "assistant-lock", tabId: targetId, owner });
  if (!lock?.ok) throw new Error("此页面已有另一个助手在填写，请稍后重试");
  acquired = true;
  if (cancelled || session.stale) return;
  if (!undo) session.results = session.results.filter(canUndo);
    await checkTarget(session.snapshot);
    for (let i = 0; i < work.length; i++) {
      if (cancelled || session.stale) break;
      const entry = work[i];
      const item = session.plan.find((p) => p.fieldId === entry.fieldId);
      if (!item) continue;
      const operationId = crypto.randomUUID();
      const value = undo ? entry.before : item.answer;
      tell(`${undo ? "正在撤销" : "正在填写并核验"} ${i + 1}/${work.length}：${item.label}`);
      session.pending = { operationId, fieldId: item.fieldId, answer: value, undo, ...(undo ? { undoOf: entry.operationId } : {}), label: item.label, contextPath: item.contextPath, entityId: item.entityId, language: session.language, pageUrl: session.snapshot.url };
      await persist();
      if (cancelled || session.stale) { session.pending = null; break; }
      let result;
      try { result = await fieldAction(session.snapshot, item, undo ? "undo" : "fill", { operationId, value, expected: undo ? entry.after : undefined }); }
      catch (error) { result = { status: "changed", reason: error.message }; }
      if (undo) {
        entry.undoReason = result.reason;
        if (result.status === "verified") { entry.undone = true; item.value = entry.before || ""; item.status = item.value ? "filled" : "review"; }
        else { if (["USER_EDITED", "VALUE_CHANGED"].includes(result.code)) entry.undoBlocked = true; tell(`撤销未完成：${result.reason}`); }
      } else {
        session.results.push({ ...result, ...session.pending });
        item.selected = false;
        if (result.status === "verified" || canUndo(result)) { item.value = result.after; item.status = "filled"; }
        else if (result.status === "changed" || ["OPTIONS_CHANGED", "FIELD_CHANGED", "FIELD_REPLACED", "FIELD_MISSING", "FIELD_AMBIGUOUS"].includes(result.code)) { session.stale = true; needsRefresh = true; }
      }
      session.pending = null;
      await persist();
      render();
      await chrome.runtime.sendMessage({ type: "assistant-lock", tabId: targetId, owner });
      // Conditional questions and cascaded options need a new preview, not old approval.
      if (!undo && !cancelled && !session.stale) {
        const changes = await pageChanges(session.snapshot);
        if (changes.added || changes.changed.length) { needsRefresh = true; break; }
      }
    }
    tell(undo ? "撤销处理结束。用户修改过的字段不会被覆盖，请核对下方结果。" : cancelled ? "已停止。已完成的字段保留在结果中。" : session.stale ? "页面已变化，剩余项已停止，请重新识别。" : "填好了，请在网页检查后自己提交。");
  } finally {
    if (acquired) await chrome.runtime.sendMessage({ type: "assistant-release", tabId: targetId, owner });
    await persist(); setBusy(false); render();
  }
  if (needsRefresh && !cancelled) {
    await prepare(false, true);
    if (!cancelled && !session.stale) tell("网页出现变化，预览已自动更新。查看新增或变化的答案后，再点“填写”；已完成结果保留在顶部。");
  }
}
function showLearning(items) {
  items = items.map((item) => ({ ...item, language: item.language || session.language, pageUrl: item.pageUrl || session.snapshot.url }));
  learnItems = items;
  $("learnPreview").hidden = !items.length;
  $("learnList").innerHTML = items.map((item, index) => `<article class="memory-preview" data-learn="${index}"><label><input type="checkbox" data-learn-check checked> ${escape(item.contextPath || item.label)}</label><textarea class="answer" data-learn-answer rows="3">${escape(item.answer)}</textarea><label>复用范围 <select data-learn-scope><option value="page">仅此岗位链接</option><option value="global">通用答案</option></select></label><p class="hint">主体：${escape(entityLabel(item.entityId))} · ${(item.language || session.language) === "en" ? "English" : "中文"}</p></article>`).join("");
  if (!items.length) tell("未找到可学习的已填写答案。");
}
async function saveLearned() {
  if (busy) return;
  // Freeze the entire reviewed batch before any await can yield to another UI action.
  const selected = [...$("learnList").querySelectorAll("[data-learn]")].filter((node) => node.querySelector("[data-learn-check]").checked).map((node) => {
    const item = learnItems[Number(node.dataset.learn)];
    const scope = node.querySelector("[data-learn-scope]").value === "global" ? "global" : scopeFor(item.pageUrl || session.snapshot.url);
    return { node, memory: { question: item.label, answer: node.querySelector("[data-learn-answer]").value.trim(), language: item.language || session.language, entityId: item.entityId, scope, origin: "user_confirmed", contextPath: item.contextPath } };
  });
  if (!selected.length) { tell("请先选中已核对的答案。"); return; }
  if (selected.some(({ memory }) => !memory.answer)) throw new Error("选中的答案不能为空，请补充后再保存。");
  setBusy(true, "saving");
  try {
    for (const { node, memory } of selected) {
      await saveMemory(memory);
      node.querySelector("[data-learn-check]").checked = false;
    }
    tell("已保存选中的问答。个人信息保持原样。");
    $("learnPreview").hidden = true;
  } finally {
    setBusy(false);
    await persist();
  }
}
async function tabNotice() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  $("tabNotice").hidden = !targetId || tab?.id === targetId;
  $("tabNotice").textContent = "当前查看的是另一标签页；助手仍绑定原申请页面。";
}
function handleError(error) {
  clearPageAccessRecovery();
  tell(error.message || "操作失败，请重试");
  if (error.origin && error.tabId === targetId) {
    $("targetTitle").textContent = error.title;
    $("targetUrl").textContent = error.origin;
  }
  if (error.code !== "PAGE_ACCESS_REQUIRED" || error.tabId !== targetId || !/^https?:\/\//.test(error.origin || "")) return;
  pageAccessRecovery = { tabId: error.tabId, pageUrl: error.pageUrl, origin: error.origin };
  $("allowPageAccess").textContent = `允许读取此站点（${new URL(error.origin).host}）`;
  $("allowPageAccess").disabled = busy;
  $("allowPageAccess").hidden = false;
}
function run(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(handleError); }
$("allowPageAccess").addEventListener("click", () => {
  const recovery = pageAccessRecovery;
  if (!recovery || busy || recovery.tabId !== targetId) return;
  let pending;
  // Stay inside the user's click gesture. No permission is requested by scans.
  try { pending = chrome.permissions.request({ origins: [recovery.origin + "/*"] }); }
  catch { tell("未能发起站点访问请求，请回到申请页点击插件图标后重试。"); return; }
  $("allowPageAccess").disabled = true;
  Promise.resolve(pending).then(async (granted) => {
    if (pageAccessRecovery !== recovery || targetId !== recovery.tabId) return;
    if (!granted) { tell("尚未允许读取此站点。可以稍后重试，或回到申请页点击插件图标后识别。"); return; }
    const tab = await chrome.tabs.get(recovery.tabId);
    if (pageAccessRecovery !== recovery || targetId !== recovery.tabId) return;
    if (tab.url !== recovery.pageUrl) { clearPageAccessRecovery(); tell("目标页面已变化，请重新识别。"); return; }
    await prepare(false, true).catch(handleError);
  }).catch(() => { if (pageAccessRecovery === recovery) tell("站点访问恢复未完成，请重新识别后重试。"); }).finally(() => {
    $("allowPageAccess").disabled = busy;
  });
});
$("useCurrent").addEventListener("click", run(bindCurrent));
$("prepare").addEventListener("click", run(() => prepare(false, !!session?.stale && !!session?.snapshot)));
$("framePermissions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-frame-origin]");
  if (!button || busy || !session?.snapshot) return;
  const origin = button.dataset.frameOrigin;
  const snapshot = session.snapshot;
  if (!snapshot.failedFrames?.some((frame) => frame.frameId !== 0 && frame.origin === origin) || !/^https?:\/\//.test(origin)) return;
  // Call request directly in the click handler so Chrome sees the user gesture.
  let pending;
  try { pending = chrome.permissions.request({ origins: [origin + "/*"] }); }
  catch (error) { handleError(error); return; }
  button.disabled = true;
  Promise.resolve(pending).then(async (granted) => {
    if (session?.snapshot !== snapshot || targetId !== snapshot.tabId) return;
    if (!granted) { tell("尚未允许读取该内嵌表单，已保留当前预览；可以稍后重试。"); return; }
    tell("已获得内嵌表单访问权限，正在重新识别。");
    await prepare(false, true);
  }).catch(handleError).finally(() => { if (button.isConnected) button.disabled = busy; });
});
$("refresh").addEventListener("click", run(() => prepare(false, true)));
for (const [id, selected] of [["selectAll", true], ["clearSelection", false]]) $(id).addEventListener("click", run(async () => {
  if (busy || !session || session.stale) return;
  session.plan = session.plan.map((item) => isFillable(item) ? { ...item, selected, selectionExplicit: true } : item);
  render(); await persist();
}));
$("showAll").addEventListener("click", run(async () => {
  if (busy || !session || session.stale) return;
  session.showAll = !session.showAll;
  session.openGroups = session.showAll ? [...panelGroups] : ["attention"];
  session.attentionMore = session.showAll;
  render(); await persist();
}));
$("learn").addEventListener("click", run(() => prepare(true)));
$("fill").addEventListener("click", run(() => fillSelected()));
$("undo").addEventListener("click", run(() => fillSelected(true)));
$("saveLearned").addEventListener("click", run(saveLearned));
$("cancel").addEventListener("click", () => { cancelled = true; clearDraftConfirmation(); aborter?.abort(); recordCard.cancel(); $("cancel").disabled = true; tell("已请求停止，当前控件完成核验后停止后续操作。"); });
$("menuButton").addEventListener("click", () => {
  $("menu").hidden = !$("menu").hidden;
  $("menuButton").setAttribute("aria-expanded", String(!$("menu").hidden));
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#menuButton") || event.target.closest("#menu") && !event.target.closest("a, button")) return;
  $("menu").hidden = true;
  $("menuButton").setAttribute("aria-expanded", "false");
});
$("language").addEventListener("change", run(async () => { if (session) { clearDraftConfirmation(); recordCard.cancel(); session.languageChoice = $("language").value; session.languageExplicit = true; session.stale = true; refreshSummary(); void recordCard.render(); await persist(); tell("语言已切换，请重新识别。"); } }));
$("questions").addEventListener("input", run(async (event) => {
  if (event.target.matches("[data-binding]")) return;
  const node = event.target.closest("[data-id]");
  const item = session?.plan.find((p) => p.fieldId === node?.dataset.id);
  if (!item || busy) return;
  if (event.target.matches("[data-answer]")) {
    clearDraftConfirmation();
    document.querySelectorAll("[data-draft-confirmation]").forEach((confirmation) => confirmation.remove());
    item.answer = event.target.multiple ? JSON.stringify([...event.target.selectedOptions].map((op) => op.value).filter(Boolean)) : event.target.value;
    item.edited = true; item.source = "本次手动编辑"; item.factIds = []; item.status = "review";
    item.selectionExplicit = false;
    item.selected = isFillable(item);
    const checkbox = node.querySelector("[data-selected]");
    checkbox.checked = item.selected; checkbox.disabled = !item.selected; checkbox.dataset.unavailable = String(!item.selected);
    const status = node.querySelector(".status");
    status.className = "status review"; status.textContent = labels.review; status.hidden = false;
    node.classList.add("needs-review");
    node.querySelector(".source").textContent = item.source;
    node.querySelector("[data-error]").textContent = validateValue(item, item.answer);
  }
  if (event.target.matches("[data-selected]")) { item.selected = event.target.checked && isFillable(item); item.selectionExplicit = true; }
  refreshSummary(); await persist();
}));
$("questions").addEventListener("change", run(async (event) => {
  if (!event.target.matches("[data-binding]") || busy) return;
  clearDraftConfirmation();
  session.bindings[event.target.dataset.binding] = event.target.value;
  const newPlan = preparePlan(session.snapshot, facts, await getMemories(), session.language, session.bindings);
  session.plan = newPlan.map((p) => p.groupId === event.target.dataset.binding ? finalizePreview([p])[0] : session.plan.find((old) => old.fieldId === p.fieldId) || p);
  render(); await persist();
}));
$("questions").addEventListener("click", run(async (event) => {
  if (busy) return;
  const draftButton = event.target.closest("[data-draft], [data-draft-send], [data-draft-cancel]");
  if (draftButton) {
    if (!session?.snapshot || session.stale) return;
    const item = session.plan.find((candidate) => candidate.fieldId === draftButton.closest("[data-id]")?.dataset.id);
    if (!item) return;
    if (draftButton.hasAttribute("data-draft-cancel")) { clearDraftConfirmation(); render(); return; }
    if (draftButton.hasAttribute("data-draft-send")) await sendDraft(item);
    else await confirmDraft(item);
    return;
  }
  const toggle = event.target.closest("[data-group-toggle]");
  if (toggle && session) {
    const id = toggle.dataset.groupToggle;
    const opened = new Set(session.openGroups || ["attention"]);
    if (opened.has(id)) opened.delete(id); else opened.add(id);
    session.openGroups = [...opened]; session.showAll = false;
    render(); await persist(); return;
  }
  if (event.target.closest("[data-more-toggle]") && session) {
    session.attentionMore = !session.attentionMore;
    if (!session.attentionMore) session.showAll = false;
    render(); await persist(); return;
  }
  const source = event.target.closest("[data-source-toggle]");
  if (source && session) {
    const card = source.closest("[data-id]");
    const opened = new Set(session.sourceOpen || []);
    if (opened.has(card.dataset.id)) opened.delete(card.dataset.id); else opened.add(card.dataset.id);
    session.sourceOpen = [...opened]; card.classList.toggle("source-open", opened.has(card.dataset.id));
    await persist(); return;
  }
  if (!event.target.matches("[data-locate]")) return;
  const item = session.plan.find((p) => p.fieldId === event.target.closest("[data-id]").dataset.id);
  await chrome.tabs.update(targetId, { active: true });
  await fieldAction(session.snapshot, item, "locate");
}));
$("questions").addEventListener("keydown", (event) => {
  if (event.target.matches("[data-source-toggle]") && ["Enter", " "].includes(event.key)) { event.preventDefault(); event.target.click(); }
});
$("resultList").addEventListener("click", run(async (event) => {
  const button = event.target.closest("[data-result-locate]");
  if (!button || busy || !session?.snapshot) return;
  const item = session.plan.find((p) => p.fieldId === button.dataset.resultLocate);
  if (!item) return;
  await chrome.tabs.update(targetId, { active: true });
  await fieldAction(session.snapshot, item, "locate");
}));
$("saveResults").addEventListener("click", () => {
  if (busy || !session) return;
  const latest = new Map();
  for (const result of session.results) if (result.status === "verified" && !result.undone) latest.set(result.fieldId, result);
  showLearning([...latest.values()].map((result) => ({ ...session.plan.find((item) => item.fieldId === result.fieldId), ...result })));
  $("learnPreview").scrollIntoView({ behavior: "smooth" });
});
chrome.tabs.onActivated.addListener(run(tabNotice));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === targetId && (change.url || change.status === "loading")) clearPageAccessRecovery();
  if (id === targetId && (change.url || change.status === "loading") && session?.snapshot) { clearDraftConfirmation(); session.stale = true; cancelled = true; aborter?.abort(); recordCard.cancel(); render(); tell("目标页面已变化，请重新识别当前步骤。"); }
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id !== targetId) return;
  clearPageAccessRecovery(); clearDraftConfirmation(); cancelled = true; aborter?.abort(); recordCard.cancel();
  if (session?.snapshot) session.stale = true;
  render(); tell("原申请标签页已关闭，请在申请页重新打开助手，或在菜单中改为当前页面。");
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[AI_SETTINGS_STORAGE_KEY] && session?.snapshot) { clearDraftConfirmation(); session.stale = true; cancelled = true; aborter?.abort(); recordCard.cancel(); render(); tell("AI 设置已更新，请重新识别以使用新设置。"); }
  if (area === "local" && changes[PROFILE_STORAGE_KEY] && session?.snapshot) { clearDraftConfirmation(); session.stale = true; cancelled = true; aborter?.abort(); recordCard.cancel(); render(); tell("个人信息已更新，请重新识别以使用最新资料。"); }
  if (area === "local" && changes[MEMORY_KEY] && session?.memoryVersion) { clearDraftConfirmation(); session.stale = true; cancelled = true; aborter?.abort(); recordCard.cancel(); render(); tell("问答记忆已更新，请更新问题以使用最新答案。"); }
  if (area === "local" && changes[STORAGE_KEY]) void recordCard.render();
});
run(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  const data = await chrome.storage.session.get(targetKey());
  targetId = data[targetKey()];
  session = await loadSession(windowId);
  if (session?.tabId !== targetId) session = null;
  facts = factsFromProfile(await getProfile(), session?.language || "zh");
  if (session?.snapshot) {
    try { await checkTarget(session.snapshot); } catch { session.stale = true; }
    if (session.schemaVersion !== SESSION_VERSION || versionOf(await getMemories()) !== session.memoryVersion) session.stale = true;
    if (versionOf(await getProfile()) !== session.profileVersion) session.stale = true;
    const settings = await getAiSettings();
    if (versionOf(settings) !== session.settingsVersion) session.stale = true;
    session.aiEnabled = settings.enabled && !!settings.apiKey;
    if (!session.stale && !session.recordDraft) void recordCard.prepare(session.snapshot, settings);
    if (session.pending && !session.stale) {
      const pending = session.pending;
      const item = session.plan.find((p) => p.fieldId === pending.fieldId);
      try {
        const result = await fieldAction(session.snapshot, item, "operation-result", { operationId: pending.operationId });
        if (!pending.undo && (result.status === "verified" || canUndo(result))) {
          if (!session.results.some((entry) => entry.operationId === pending.operationId)) session.results.push({ ...result, ...pending });
          item.value = result.after; item.status = "filled"; item.selected = false;
        } else if (pending.undo && pending.undoOf && result.status === "verified") {
          const entry = session.results.find((entry) => entry.operationId === pending.undoOf);
          if (entry) { entry.undone = true; entry.undoReason = result.reason; item.value = entry.before || ""; item.status = item.value ? "filled" : "review"; }
          else session.stale = true;
        } else session.stale = true;
      } catch { session.stale = true; }
      session.pending = null;
      await persist();
      tell("已恢复上次结果，请核对后继续；未确认的操作不会自动重试。");
    }
  }
  if (!targetId) await bindCurrent();
  else { render(); setBusy(false); await tabNotice(); }
})();

let checkingChanges = false;
setInterval(async () => {
  if (busy || checkingChanges || !session?.snapshot || session.stale || document.hidden) return;
  checkingChanges = true;
  const checkedSession = session;
  const checkedSnapshot = session.snapshot;
  try {
    const changes = await pageChanges(checkedSnapshot);
    if (busy || session !== checkedSession || session.snapshot !== checkedSnapshot) return;
    const changeSignature = JSON.stringify(changes);
    if ((changes.added || changes.changed.length) && session.changeSignature !== changeSignature) {
      clearDraftConfirmation();
      session.changeSignature = changeSignature;
      for (const item of session.plan) if (changes.changed.includes(item.fieldId) && item.status !== "filled") {
        item.selected = false; item.supported = false; item.status = "unsupported"; item.reason = "字段已变化，请重新识别";
      }
      tell(`网页表单有变化（新增 ${changes.added} 项、变化 ${changes.changed.length} 项）。点“更新”查看后再统一确认。`);
      render();
    }
  } catch {
    if (!busy && session === checkedSession && session.snapshot === checkedSnapshot) {
      clearDraftConfirmation(); recordCard.cancel(); session.stale = true; render(); tell("目标页面已变化，请重新识别。");
    }
  }
  finally { checkingChanges = false; }
}, 2500);
window.addEventListener("pagehide", () => { clearDraftConfirmation(); cancelled = true; aborter?.abort(); recordCard.cancel(); });
