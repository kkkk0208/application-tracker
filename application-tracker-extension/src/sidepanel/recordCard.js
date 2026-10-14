import { STATUSES } from "../constants.js";
import { buildRecordDraft, recentJobChoices, recordStatus } from "../assistant/recordDraft.js";
import { checkTarget } from "../assistant/session.js";
import { collectJobSignals } from "../jobInfo/collectSignals.js";
import { extractJobInfo } from "../jobInfo/extractJobInfo.js";
import { requestJobInfo, shouldRequestJobInfo } from "../jobInfo/aiJobInfo.js";
import { loadRecentJobs, rememberJob } from "../jobInfo/recentJobs.js";
import { getRecords, saveNewRecord } from "../storage.js";

const text = (value) => typeof value === "string" ? value.trim() : "";
const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function createRecordCard({ container, getSession, persist, isBusy, setBusy, tell }) {
  let preparation = 0, rendering = 0, saving = false, aborter, shownDuplicateConfirmation = null;
  const current = (session, snapshot, url) => getSession() === session && session.snapshot === snapshot && snapshot.url === url && !session.stale;
  const persistSafely = async (session = getSession(), saved = false) => {
    try { await persist(); return true; }
    catch {
      if (getSession() === session) {
        session.recordError = saved ? "已记录，恢复状态暂存失败" : "投递草稿暂存失败，关闭侧栏后可能丢失";
        tell(session.recordError);
      }
      return false;
    }
  };
  const statusName = (status) => STATUSES.find((item) => item.key === status)?.label || status;
  const duplicateConfirmation = (draft, duplicate) => JSON.stringify([
    text(draft.company), text(draft.role), text(draft.portalLink), duplicate.reason,
    duplicate.record.id || [duplicate.record.company, duplicate.record.role, duplicate.record.portalLink]
  ]);
  const invalidateDuplicateConfirmation = () => {
    shownDuplicateConfirmation = null;
    rendering++;
    const button = container.querySelector("#saveRecordAnyway");
    if (button) button.disabled = true;
  };

  function supplement(session, info, ai = false) {
    for (const key of ["company", "role", "base"]) {
      if (saving || session.recordSaved || session.recordEdited?.[key] || text(session.recordDraft[key]) || !text(info[key])) continue;
      if (!["high", "medium"].includes(ai ? info.confidence : info.confidence?.[key])) continue;
      session.recordDraft[key] = text(info[key]);
      if (key !== "base") session.recordDraft.origin[key] = ai ? "AI 识别，请核对" : text(info.source?.[key]);
    }
  }

  async function prepare(snapshot, settings) {
    const session = getSession(), run = ++preparation, url = snapshot?.url;
    aborter?.abort(); aborter = new AbortController();
    const signal = aborter.signal;
    if (!session || !snapshot || !current(session, snapshot, url)) return;
    if (session.recordDraft?.portalLink !== url) {
      invalidateDuplicateConfirmation();
      session.recordDraft = buildRecordDraft({ url, title: snapshot.title });
      session.recordEdited = {};
      session.recentJobs = [];
      delete session.recordSaved;
      delete session.recordInfo;
      delete session.recordError;
    }
    session.recordEdited ||= {};
    session.recordDraft.origin ||= { company: "", role: "" };
    const valid = () => run === preparation && current(session, snapshot, url) && !signal.aborted && !saving;
    await persistSafely();
    try {
      await checkTarget(snapshot);
      if (!valid()) return;
      const [response] = await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, frameIds: [0] }, func: collectJobSignals });
      if (!valid()) return;
      const main = snapshot.frames.find((frame) => frame.frameId === 0);
      if (!main?.documentId || response?.documentId !== main.documentId) return;
      await checkTarget(snapshot);
      if (!valid()) return;
      const signals = response?.result || {};
      const info = extractJobInfo(signals);
      session.recordInfo = info;
      supplement(session, info);
      await rememberJob(chrome.storage.session, url, info);
      if (!valid()) return;
      let hostname = ""; try { hostname = new URL(url).hostname; } catch { /* Manual draft remains available. */ }
      const recent = await loadRecentJobs(chrome.storage.session);
      if (!valid()) return;
      session.recentJobs = recentJobChoices(recent, hostname);
      await persistSafely();
      void render();
      if (!shouldRequestJobInfo(settings, info)) return;
      const ai = await requestJobInfo(settings, signals, signal);
      if (!valid() || !ai || !["high", "medium"].includes(ai.confidence)) return;
      await checkTarget(snapshot);
      if (!valid()) return;
      supplement(session, ai, true);
      await persistSafely();
      void render();
    } catch {
      // Job extraction is optional and must never block the filling preview.
      if (valid()) { await persistSafely(); void render(); }
    }
  }

  async function render() {
    const session = getSession(), run = ++rendering;
    container.hidden = !session?.results?.length;
    if (container.hidden || !session.recordDraft) { shownDuplicateConfirmation = null; container.innerHTML = ""; return; }
    if (!saving && !session.recordSaved && ["recordCompany", "recordRole"].includes(container.ownerDocument?.activeElement?.id)) return;
    if (session.recordSaved) {
      shownDuplicateConfirmation = null;
      container.innerHTML = `<h2>提交后记一笔</h2><p>已记录 ✓ · <a href="../records/records.html" target="_blank">在列表中查看</a></p>${session.recordError ? `<p data-record-error role="status">${escape(session.recordError)}</p>` : ""}`;
      return;
    }
    let records = [];
    try { records = await getRecords(); } catch { /* Saving performs a fresh read and reports failures inline. */ }
    if (run !== rendering || getSession() !== session || session.recordSaved || !saving && ["recordCompany", "recordRole"].includes(container.ownerDocument?.activeElement?.id)) return;
    const draft = session.recordDraft;
    const duplicate = recordStatus(draft, records).duplicate;
    shownDuplicateConfirmation = duplicate ? duplicateConfirmation(draft, duplicate) : null;
    const disabled = saving || isBusy() ? "disabled" : "";
    const recent = !text(draft.role) && session.recentJobs?.length
      ? `<label>用最近看过的岗位<select id="recordRecent" ${disabled}><option value="">请选择最近识别的岗位</option>${session.recentJobs.map((job, index) => `<option value="${index}">${escape([job.company, job.role, job.base].filter(Boolean).join(" · "))}</option>`).join("")}</select></label>` : "";
    const action = duplicate
      ? `<p>已记录过：${escape(duplicate.record.company)} · ${escape(duplicate.record.role)}（${escape(statusName(duplicate.record.status))}） <a href="../records/records.html" target="_blank">查看</a></p><button id="saveRecordAnyway" type="button" ${disabled}>仍然记录</button>`
      : `<button id="saveRecord" type="button" ${disabled}>记录投递</button>`;
    container.innerHTML = `<h2>提交后记一笔</h2><label>公司<input id="recordCompany" value="${escape(draft.company)}" ${disabled}></label><label>岗位<input id="recordRole" value="${escape(draft.role)}" ${disabled}></label><p class="hint" data-record-origin>${escape([draft.origin?.company, draft.origin?.role].filter(Boolean).join(" · "))}</p>${recent}${action}<p data-record-error role="status" ${session.recordError ? "" : "hidden"}>${escape(session.recordError || "")}</p>`;
  }

  container.addEventListener("input", (event) => {
    const key = { recordCompany: "company", recordRole: "role" }[event.target.id];
    const session = getSession();
    if (!key || !session?.recordDraft || session.recordSaved || saving || isBusy()) return;
    invalidateDuplicateConfirmation();
    session.recordDraft[key] = event.target.value;
    session.recordEdited ||= {}; session.recordEdited[key] = true;
    session.recordDraft.origin ||= {}; session.recordDraft.origin[key] = "手动填写";
    delete session.recordError;
    const origin = container.querySelector("[data-record-origin]");
    if (origin) origin.textContent = [session.recordDraft.origin.company, session.recordDraft.origin.role].filter(Boolean).join(" · ");
    void persistSafely();
  });
  container.addEventListener("change", (event) => {
    const session = getSession();
    if (!session?.recordDraft || session.recordSaved || saving || isBusy()) return;
    if (event.target.id === "recordRecent" && event.target.value !== "") {
      const job = session.recentJobs?.[Number(event.target.value)];
      if (!job) return;
      invalidateDuplicateConfirmation();
      session.recordEdited ||= {};
      for (const key of ["company", "role", "base"]) {
        if (text(session.recordDraft[key]) || !text(job[key])) continue;
        session.recordDraft[key] = text(job[key]);
        session.recordEdited[key] = true;
        if (key !== "base") session.recordDraft.origin[key] = "最近岗位";
      }
      delete session.recordError;
      void persistSafely();
    }
    if (["recordRecent", "recordCompany", "recordRole"].includes(event.target.id)) void render();
  });
  container.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (["saveRecord", "saveRecordAnyway"].includes(button?.id)) void save(button.id === "saveRecordAnyway");
  });

  async function save(force) {
    const session = getSession();
    if (!session?.recordDraft || session.recordSaved || saving || isBusy()) return;
    if (session.stale) { session.recordError = "页面已变化，请重新识别后再记录"; void render(); return; }
    const snapshot = session.snapshot, url = snapshot?.url;
    const confirmedDuplicate = shownDuplicateConfirmation;
    const draft = structuredClone(session.recordDraft);
    draft.company = text(draft.company); draft.role = text(draft.role);
    const initial = recordStatus(draft, []);
    if (Object.keys(initial.errors).length) { session.recordError = Object.values(initial.errors).join("；"); void render(); return; }
    saving = true;
    container.querySelectorAll("input, select, button").forEach((control) => { control.disabled = true; });
    setBusy(true);
    void render();
    try {
      const { duplicate, errors } = recordStatus(draft, await getRecords());
      if (!current(session, snapshot, url)) { session.recordError = "页面已变化，请重新识别后再记录"; return; }
      if (Object.keys(errors).length) { session.recordError = Object.values(errors).join("；"); return; }
      if (duplicate && (!force || confirmedDuplicate !== duplicateConfirmation(draft, duplicate))) { session.recordError = "已记录过，请核对后再选择「仍然记录」"; return; }
      await checkTarget(snapshot);
      if (!current(session, snapshot, url)) { session.recordError = "页面已变化，请重新识别后再记录"; return; }
      const saved = await saveNewRecord(draft);
      session.recordSaved = { id: saved.id, at: saved.createdAt || new Date().toISOString() };
      if (getSession() !== session) return;
      if (session.stale) session.recordError = "已记录；页面已变化，请重新识别";
      else delete session.recordError;
      if (await persistSafely(session, true)) tell(session.stale ? "投递已记录；页面已变化，请重新识别" : "投递已记录");
    } catch (error) {
      if (getSession() === session) session.recordError = `保存失败：${error.message}`;
    } finally {
      saving = false;
      setBusy(false);
      void render();
    }
  }

  function cancel() { preparation++; aborter?.abort(); }
  return { prepare, render, cancel };
}
