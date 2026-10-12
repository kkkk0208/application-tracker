import { getProfile, getAiSettings } from "../storage.js";
import { PROFILE_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY } from "../constants.js";
import { factsFromProfile, preparePlan, validateValue, versionOf, scopeFor } from "../assistant/planner.js";
import { buildAiBatches, requestBatch, recognizeQuestions, recognitionCandidates } from "../assistant/ai.js";
import { scanPage, checkTarget, fieldAction, pageChanges, inspectOptions } from "../assistant/session.js";
import { getMemories, saveMemory, loadSession, saveSession, MEMORY_KEY } from "../assistant/store.js";
import { reconcilePlan, entityLabel } from "../assistant/reconcile.js";
import { isFillable, finalizePreview, previewStats } from "../assistant/preview.js";
import { captureVisualContext } from "../assistant/visualCapture.js";
import { needsVisualRecognition, visionCandidates, requestVisualRecognition, applyVisualObservations, restoreVisualContext } from "../assistant/vision.js";

const $ = (id) => document.getElementById(id);
const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const labels = { ready: "已有明确答案", review: "请重点核对", missing: "缺少资料", filled: "已填写", unsupported: "需在网页处理" };
let session = null;
let windowId;
let targetId;
let facts = [];
let busy = false;
let aborter;
let cancelled = false;
let learnItems = [];
let saves = Promise.resolve();
const owner = crypto.randomUUID();
const SESSION_VERSION = 6;
const targetKey = () => `applicationTracker.assistant.target.${windowId}`;
const tell = (text) => { $("message").textContent = text; };
function persist() {
  const value = structuredClone(session);
  saves = saves.catch(() => {}).then(() => saveSession(windowId, value));
  return saves;
}
function setBusy(value, phase = "review") {
  busy = value;
  if (session) session.phase = phase;
  for (const id of ["prepare", "useCurrent", "language", "learn", "refresh", "saveLearned", "saveResults", "selectAll", "clearSelection"]) $(id).disabled = value;
  document.querySelectorAll("[data-answer], [data-selected], [data-binding], [data-locate], [data-learn-check], [data-learn-answer], [data-learn-scope], [data-frame-origin]").forEach((input) => { input.disabled = value || input.dataset.unavailable === "true"; });
  $("cancel").hidden = !value || phase === "saving";
  $("cancel").disabled = false;
  $("connection").textContent = value ? phase === "filling" ? "填写中" : phase === "saving" ? "保存中" : "准备中" : session?.stale ? "需要重新识别" : targetId ? "已绑定页面" : "等待连接";
  refreshSummary();
}
function refreshSummary() {
  const plan = session?.plan || [];
  const stats = previewStats(plan);
  $("fill").textContent = `确认并填写 ${stats.selected} 项`;
  $("fill").disabled = busy || session?.stale || !stats.selected;
  $("selectAll").disabled = busy || session?.stale || !stats.eligible;
  $("clearSelection").disabled = busy || !stats.selected;
  $("undo").disabled = busy || session?.stale || !(session?.results || []).some((r) => r.status === "verified" && !r.undone);
  $("summary").textContent = `待确认填写 ${stats.selected} 项 · 需补充或网页处理 ${stats.missing} 项 · 网页已有 ${stats.filled} 项`;
  $("reviewSummary").textContent = stats.review ? `其中 ${stats.review} 项为草稿或需核对的答案，已标出；查看后可一次确认，无需逐项勾选。` : "有有效答案的项目已默认选中；可取消本次不想填写的项目。";
}
function render() {
  $("targetTitle").textContent = session?.snapshot?.title || "在申请页面打开助手";
  $("targetUrl").textContent = session?.snapshot ? scopeFor(session.snapshot.url) : "";
  $("language").value = session?.language || "zh";
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
  }
  const groups = new Map();
  const filter = $("filter").value;
  for (const item of session?.plan || []) {
    if (filter === "attention" ? item.value || (isFillable(item) && item.status === "ready") : filter !== "all" && item.status !== filter) continue;
    if (!groups.has(item.groupId)) groups.set(item.groupId, []);
    groups.get(item.groupId).push(item);
  }
  $("questions").innerHTML = [...groups.entries()].map(([id, items]) => {
    const name = [items[0].section, items[0].group].filter(Boolean).join(" / ") || "当前页面";
    const needsBinding = items.some((p) => /^(education|experience)\./.test(p.entityId));
    const entities = [...new Set(facts.filter((f) => /^(education|experience)\./.test(f.entityId)).map((f) => f.entityId))];
    const binding = needsBinding ? `<details class="binding" ${items.some((p) => p.entityId.includes("unknown")) ? "open" : ""}><summary>对应资料：${escape(entityLabel(items[0].entityId))} · 调整</summary><select aria-label="此分组对应的经历" data-binding="${escape(id)}" ${busy ? "disabled" : ""}><option value="">按页面识别（模糊单组教育默认硕士）</option>${entities.map((e) => `<option value="${escape(e)}" ${session.bindings?.[id] === e ? "selected" : ""}>${escape(entityLabel(e))}</option>`).join("")}</select></details>` : "";
    const collapsed = session.collapsedGroups?.includes(id);
    return `<section class="group"><div class="group-header"><h2>${escape(name)}</h2><button data-collapse="${escape(id)}" aria-expanded="${!collapsed}">${collapsed ? "展开" : "收起"}</button>${binding}</div><div ${collapsed ? "hidden" : ""}>${items.map(renderItem).join("")}</div></section>`;
  }).join("");
  renderResults();
  refreshSummary();
}
function renderItem(item) {
  const unavailable = !!item.value || !item.supported;
  const unselectable = !isFillable(item);
  const disabled = busy ? "disabled" : "";
  let input;
  if (unavailable) input = `<p class="hint">${escape(item.value ? "网页已有内容，保留原值" : item.reason)}</p>`;
  else if (item.options?.length && item.kind !== "cascader" && !item.dateRange) {
    let chosen;
    try { chosen = item.constraints.multiple ? JSON.parse(item.answer || "[]") : [item.answer]; } catch { chosen = []; }
    input = `<select class="answer" aria-label="${escape(item.label)}的答案" data-answer ${disabled} ${item.constraints.multiple ? "multiple" : ""}><option value="" ${item.constraints.multiple ? "disabled" : ""}>请选择</option>${item.options.filter((op) => !op.disabled).map((op) => `<option value="${escape(op.text)}" ${chosen.includes(op.text) ? "selected" : ""}>${escape(op.text)}</option>`).join("")}</select>`;
  } else if (item.narrative) input = `<textarea class="answer" data-answer ${disabled} rows="4" aria-label="${escape(item.label)}的答案" placeholder="补充本次答案">${escape(item.answer)}</textarea>`;
  else input = `<input class="answer" data-answer ${disabled} type="${!item.dateRange && item.kind !== "cascader" && ["date", "month", "email", "number"].includes(item.type) ? item.type : "text"}" aria-label="${escape(item.label)}的答案" placeholder="${item.dateRange ? '两个日期，如 [&quot;2022-09&quot;,&quot;2026-06&quot;]' : item.kind === "cascader" ? '路径，如 [&quot;广东省&quot;,&quot;深圳市&quot;]' : "补充本次答案"}" value="${escape(item.answer)}">`;
  const labelWarning = ["placeholder", "none"].includes(item.labelSource) ? '<span class="badge" data-label-warning>题目未识别</span>' : "";
  return `<article class="question ${item.status === "review" ? "needs-review" : ""}" data-id="${escape(item.fieldId)}"><div class="question-head"><input aria-label="选中${escape(item.label)}" type="checkbox" data-selected data-unavailable="${unselectable}" ${item.selected ? "checked" : ""} ${unselectable || busy ? "disabled" : ""}><label>${escape(item.label)}${item.constraints.required ? " *" : ""}</label><button data-locate ${disabled}>定位</button></div><span class="status ${item.status}">${labels[item.status]}</span>${labelWarning}${input}<p class="source">${escape(item.source || item.reason)}</p>${item.visualEvidence ? `<p class="source">截图辅助：${escape(item.visualEvidence)}</p>` : ""}${item.optionError ? `<p class="source">选项读取：${escape(item.optionError)}</p>` : ""}<p class="source" data-error>${escape(item.answer ? validateValue(item, item.answer) : "")}</p></article>`;
}
function renderResults() {
  const results = session?.results || [];
  $("results").hidden = !results.length;
  const verified = results.filter((r) => r.status === "verified" && !r.undone).length;
  const undone = results.filter((r) => r.undone).length;
  $("saveResults").hidden = !verified;
  $("saveResults").disabled = busy;
  $("resultSummary").textContent = `已核验 ${verified}/${results.length} 项${undone ? ` · 已撤销 ${undone} 项` : ""} · ${results.filter((r) => r.status !== "verified").length} 项需处理。成功只表示网页当前保留该值。`;
  $("resultList").innerHTML = results.map((r) => `<div class="result-row"><strong>${escape(r.label || session.plan.find((p) => p.fieldId === r.fieldId)?.label || "字段")}</strong><p>${escape(r.undone ? "已撤销" : r.undoReason ? `撤销未完成：${r.undoReason}` : r.reason)}</p>${r.status === "verified" && !r.undone ? `<button data-save-answer="${escape(r.operationId)}">核对并保存为记忆</button>` : ""}</div>`).join("");
}
async function bindCurrent() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!/^https?:\/\//.test(tab?.url || "")) throw new Error("请切换到申请网站，再点击改为当前页面");
  targetId = tab.id;
  session = { tabId: targetId, language: $("language").value, plan: [], bindings: {}, results: [], phase: "idle" };
  await chrome.storage.session.set({ [targetKey()]: targetId });
  await persist();
  render();
  $("targetTitle").textContent = tab.title;
  $("targetUrl").textContent = scopeFor(tab.url);
  await tabNotice();
  setBusy(false);
  tell("已绑定此页面，点击“识别并预览”，查看答案后一次确认填写。");
}
async function prepare(learning = false, preserve = false) {
  if (busy) return;
  if (!targetId) await bindCurrent();
  cancelled = false;
  aborter = new AbortController();
  setBusy(true, "scanning");
  tell("正在识别当前页面的分区、问题与控件…");
  let previousChoices = [];
  let previewReady = false;
  try {
    const previous = session;
    const language = $("language").value;
    const [snapshot, profile, memories, settings] = await Promise.all([scanPage(targetId), getProfile(), getMemories(), getAiSettings()]);
    if (cancelled) return;
    facts = factsFromProfile(profile, language);
    const sameDocuments = preserve && previous?.snapshot?.url === snapshot.url && JSON.stringify(previous.snapshot.frames.map((f) => f.documentId)) === JSON.stringify(snapshot.frames.map((f) => f.documentId));
    const bindings = sameDocuments ? previous.bindings || {} : {};
    session = { schemaVersion: SESSION_VERSION, tabId: targetId, snapshot, language, profileVersion: versionOf(profile), memoryVersion: versionOf(memories), bindings, results: sameDocuments ? previous.results || [] : [], collapsedGroups: sameDocuments ? previous.collapsedGroups || [] : [], plan: preparePlan(snapshot, facts, memories, language, bindings), phase: "review", stale: false };
    if (snapshot.pageType === "login") {
      session.plan = session.plan.map((p) => ({ ...p, supported: false, selected: false, status: "unsupported", reason: "请先完成登录或身份验证" }));
      tell("请在网站完成登录或验证后重新识别。");
      render(); await persist(); return;
    }
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
      $("aiDetails").hidden = false;
      $("aiDisclosure").textContent = "文字分析先发送题目、选项、提示与资料类别，再按题目发送相关资料片段与岗位背景。文字分析不发送网页已填答案；截图辅助的发送情况单独显示。";
      const unknown = recognitionCandidates(session.plan);
      for (let i = 0; i < unknown.length; i += 30) {
        if (cancelled || session.stale) break;
        tell(`AI 正在复核题意 ${i + 1}–${Math.min(i + 30, unknown.length)}/${unknown.length}…`);
        try {
          const mappings = await recognizeQuestions(settings, unknown.slice(i, i + 30), facts, aborter.signal);
          if (!cancelled && !session.stale) for (const mapping of mappings) {
            const item = session.plan.find((p) => p.fieldId === mapping.fieldId);
            if (item && !item.edited) Object.assign(item, mapping);
          }
        } catch (error) { if (!cancelled) errors.push(error.message); }
      }
    }
    const batches = buildAiBatches(session.plan, facts, snapshot, language);
    $("aiDetails").hidden = !batches.length;
    $("aiDisclosure").textContent = batches.length ? `文字分析拟发送 ${batches.reduce((n, b) => n + b.fields.length, 0)} 个问题及相关资料片段；文字请求不附带网页已填答案、完整网址或 API Key。截图辅助的发送情况单独显示。相关资料：${[...new Set(batches.flatMap((b) => b.facts.map((f) => f.label)))].join("、")}` : "";
    if (!settings.enabled || !batches.length) { tell(errors.length ? `已有答案可预览确认；${errors.join("；")}` : "预览已准备好，有效答案已默认选中。查看标记项后，点击底部“确认并填写”即可。"); return; }
    setBusy(true, "preparing");
    for (let i = 0; i < batches.length; i++) {
      if (cancelled || session.stale) break;
      tell(`本地建议已就绪，AI 正在补充第 ${i + 1}/${batches.length} 组…`);
      try {
        const response = await requestBatch(settings, batches[i], session.plan, facts, aborter.signal);
        if (cancelled || session.stale) break;
        for (const update of response.accepted) {
          const item = session.plan.find((p) => p.fieldId === update.fieldId);
          if (item && !item.edited) Object.assign(item, update);
        }
        if (response.errors.length) errors.push(`${response.errors.length} 项未通过来源或格式校验`);
        render(); await persist();
      } catch (error) { if (!cancelled) errors.push(error.name === "TimeoutError" ? "AI 请求超时" : error.message); }
    }
    tell(session.stale ? "个人资料或目标页面已变化，请重新识别。" : cancelled ? "已停止 AI 准备，保留已得到的结果。" : errors.length ? `已有答案可预览确认；${errors.join("；")}` : "预览已准备好，草稿已标出并默认选中。核对后一次确认填写。");
  } finally {
    if (previewReady && !session.stale) session.plan = finalizePreview(session.plan.map((item) => item.visualEvidence && !item.value && item.answer ? { ...item, status: "review" } : item), previousChoices);
    setBusy(false); render(); if (session) await persist();
  }
}
async function fillSelected(undo = false) {
  if (busy || !session?.snapshot || session.stale) return;
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
  const work = undo ? session.results.filter((r) => r.status === "verified" && !r.undone).slice().reverse() : session.plan.filter((p) => p.selected && isFillable(p));
  if (!work.length) return;
  const lock = await chrome.runtime.sendMessage({ type: "assistant-lock", tabId: targetId, owner });
  if (!lock?.ok) throw new Error("此页面已有另一个助手在填写，请稍后重试");
  acquired = true;
  if (cancelled || session.stale) return;
  if (!undo) session.results = session.results.filter((r) => r.status === "verified" && !r.undone);
    await checkTarget(session.snapshot);
    for (let i = 0; i < work.length; i++) {
      if (cancelled || session.stale) break;
      const entry = work[i];
      const item = session.plan.find((p) => p.fieldId === entry.fieldId);
      if (!item) continue;
      const operationId = crypto.randomUUID();
      const value = undo ? entry.before : item.answer;
      tell(`${undo ? "正在撤销" : "正在填写并核验"} ${i + 1}/${work.length}：${item.label}`);
      session.pending = { operationId, fieldId: item.fieldId, answer: value, undo, label: item.label, contextPath: item.contextPath, entityId: item.entityId, language: session.language, pageUrl: session.snapshot.url };
      await persist();
      if (cancelled || session.stale) { session.pending = null; break; }
      let result;
      try { result = await fieldAction(session.snapshot, item, undo ? "undo" : "fill", { operationId, value, expected: undo ? entry.after : undefined }); }
      catch (error) { result = { status: "changed", reason: error.message }; }
      if (undo) {
        entry.undoReason = result.reason;
        if (result.status === "verified") { entry.undone = true; item.value = entry.before || ""; item.status = item.value ? "filled" : "review"; }
        else tell(`撤销未完成：${result.reason}`);
      } else {
        session.results.push({ ...result, ...session.pending });
        item.selected = false;
        if (result.status === "verified") { item.value = result.after; item.status = "filled"; }
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
    tell(undo ? "撤销处理结束。用户修改过的字段不会被覆盖，请核对下方结果。" : cancelled ? "已停止。已完成的字段保留在结果中。" : session.stale ? "页面已变化，剩余项已停止，请重新识别。" : "本次填写已结束，请在网页核对。新答案需要单独确认才会进入问答记忆。");
  } finally {
    if (acquired) await chrome.runtime.sendMessage({ type: "assistant-release", tabId: targetId, owner });
    await persist(); setBusy(false); render();
  }
  if (needsRefresh && !cancelled) {
    await prepare(false, true);
    if (!cancelled && !session.stale) tell("网页出现变化，预览已自动更新。查看新增或变化的答案后，再点击一次确认继续；已完成结果保留在下方。");
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
function handleError(error) { tell(error.message || "操作失败，请重试"); }
function run(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(handleError); }
$("useCurrent").addEventListener("click", run(bindCurrent));
$("prepare").addEventListener("click", run(() => prepare()));
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
$("nextMissing").addEventListener("click", () => {
  const missing = session?.plan.find((p) => p.constraints.required && !p.value && !isFillable(p));
  if (!missing) { tell("当前可见问题没有待补充的必填缺口；请在网站核对隐藏题目和最终要求。"); return; }
  $("filter").value = "all";
  session.collapsedGroups = (session.collapsedGroups || []).filter((id) => id !== missing.groupId);
  render();
  const card = [...document.querySelectorAll(".question")].find((node) => node.dataset.id === missing.fieldId);
  card?.scrollIntoView({ block: "center", behavior: "smooth" });
  card?.querySelector("[data-answer]")?.focus({ preventScroll: true });
});
$("learn").addEventListener("click", run(() => prepare(true)));
$("fill").addEventListener("click", run(() => fillSelected()));
$("undo").addEventListener("click", run(() => fillSelected(true)));
$("saveLearned").addEventListener("click", run(saveLearned));
$("cancel").addEventListener("click", () => { cancelled = true; aborter?.abort(); $("cancel").disabled = true; tell("已请求停止，当前控件完成核验后停止后续操作。"); });
$("filter").addEventListener("change", render);
$("language").addEventListener("change", () => { if (session) { session.stale = true; refreshSummary(); tell("语言已切换，请重新识别。"); } });
$("questions").addEventListener("input", run(async (event) => {
  if (event.target.matches("[data-binding]")) return;
  const node = event.target.closest("[data-id]");
  const item = session?.plan.find((p) => p.fieldId === node?.dataset.id);
  if (!item || busy) return;
  if (event.target.matches("[data-answer]")) {
    item.answer = event.target.multiple ? JSON.stringify([...event.target.selectedOptions].map((op) => op.value).filter(Boolean)) : event.target.value;
    item.edited = true; item.source = "本次手动编辑"; item.factIds = []; item.status = "review";
    item.selectionExplicit = false;
    item.selected = isFillable(item);
    const checkbox = node.querySelector("[data-selected]");
    checkbox.checked = item.selected; checkbox.disabled = !item.selected; checkbox.dataset.unavailable = String(!item.selected);
    const status = node.querySelector(".status");
    status.className = "status review"; status.textContent = labels.review;
    node.classList.add("needs-review");
    node.querySelector(".source").textContent = item.source;
    node.querySelector("[data-error]").textContent = validateValue(item, item.answer);
  }
  if (event.target.matches("[data-selected]")) { item.selected = event.target.checked && isFillable(item); item.selectionExplicit = true; }
  refreshSummary(); await persist();
}));
$("questions").addEventListener("change", run(async (event) => {
  if (!event.target.matches("[data-binding]") || busy) return;
  session.bindings[event.target.dataset.binding] = event.target.value;
  const newPlan = preparePlan(session.snapshot, facts, await getMemories(), session.language, session.bindings);
  session.plan = newPlan.map((p) => p.groupId === event.target.dataset.binding ? finalizePreview([p])[0] : session.plan.find((old) => old.fieldId === p.fieldId) || p);
  render(); await persist();
}));
$("questions").addEventListener("click", run(async (event) => {
  if (event.target.matches("[data-collapse]")) {
    const id = event.target.dataset.collapse;
    const collapsed = new Set(session.collapsedGroups || []);
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    session.collapsedGroups = [...collapsed]; render(); await persist(); return;
  }
  if (busy) return;
  if (!event.target.matches("[data-locate]")) return;
  const item = session.plan.find((p) => p.fieldId === event.target.closest("[data-id]").dataset.id);
  await chrome.tabs.update(targetId, { active: true });
  await fieldAction(session.snapshot, item, "locate");
}));
$("resultList").addEventListener("click", (event) => {
  const id = event.target.dataset.saveAnswer;
  if (!id || busy) return;
  const result = session.results.find((r) => r.operationId === id && r.status === "verified" && !r.undone);
  if (!result) return;
  const item = session.plan.find((p) => p.fieldId === result.fieldId);
  showLearning([{ ...item, ...result }]);
  $("learnPreview").scrollIntoView({ behavior: "smooth" });
});
$("saveResults").addEventListener("click", () => {
  if (busy || !session) return;
  const latest = new Map();
  for (const result of session.results) if (result.status === "verified" && !result.undone) latest.set(result.fieldId, result);
  showLearning([...latest.values()].map((result) => ({ ...session.plan.find((item) => item.fieldId === result.fieldId), ...result })));
  $("learnPreview").scrollIntoView({ behavior: "smooth" });
});
chrome.tabs.onActivated.addListener(run(tabNotice));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === targetId && (change.url || change.status === "loading") && session?.snapshot) { session.stale = true; cancelled = true; aborter?.abort(); refreshSummary(); tell("目标页面已变化，请重新识别当前步骤。"); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[AI_SETTINGS_STORAGE_KEY] && session?.snapshot) { session.stale = true; cancelled = true; aborter?.abort(); refreshSummary(); tell("AI 设置已更新，请重新识别以使用新设置。"); }
  if (area === "local" && changes[PROFILE_STORAGE_KEY] && session?.snapshot) { session.stale = true; cancelled = true; aborter?.abort(); refreshSummary(); tell("个人信息已更新，请重新识别以使用最新资料。"); }
  if (area === "local" && changes[MEMORY_KEY] && session?.memoryVersion) { session.stale = true; cancelled = true; aborter?.abort(); refreshSummary(); tell("问答记忆已更新，请更新问题以使用最新答案。"); }
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
    if (session.pending && !session.stale) {
      const pending = session.pending;
      const item = session.plan.find((p) => p.fieldId === pending.fieldId);
      try {
        const result = await fieldAction(session.snapshot, item, "operation-result", { operationId: pending.operationId });
        if (result.status === "verified" && !pending.undo) {
          session.results.push({ ...result, ...pending }); item.value = result.after; item.status = "filled"; item.selected = false;
        } else session.stale = true;
      } catch { session.stale = true; }
      session.pending = null;
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
      session.changeSignature = changeSignature;
      for (const item of session.plan) if (changes.changed.includes(item.fieldId) && item.status !== "filled") {
        item.selected = false; item.supported = false; item.status = "unsupported"; item.reason = "字段已变化，请重新识别";
      }
      tell(`网页表单有变化（新增 ${changes.added} 项、变化 ${changes.changed.length} 项）。点击“更新预览，保留修改”查看后再统一确认。`);
      render();
    }
  } catch {
    if (!busy && session === checkedSession && session.snapshot === checkedSnapshot) {
      session.stale = true; refreshSummary(); tell("目标页面已变化，请重新识别。");
    }
  }
  finally { checkingChanges = false; }
}, 2500);
