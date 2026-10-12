import { getMemories, saveMemory, deleteMemory, MEMORY_KEY } from "../assistant/store.js";
import { scopeFor, MEMORY_SCOPE_VERSION } from "../assistant/planner.js";
import { getProfile } from "../storage.js";
import { requestStorageMutation } from "../storageClient.js";
import { validateBackup, MAX_BACKUP_BYTES } from "../backup.js";
import { toDateInputValue } from "../dateUtils.js";
import { RECOVERY_KEY } from "../storageKeys.js";

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const entityNames = { self: "本人", "education.master": "硕士教育", "education.bachelor": "本科教育", "family.father": "父亲", "family.mother": "母亲", "family.unknown": "其他家庭成员" };
let memories = [];
let profile = {};
let pendingBackup = null;
let preview = null;
let saving = false;
let previewRevision = 0;
const tell = (text) => { $("message").textContent = text; $("message").hidden = false; };
const run = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((error) => tell(error.message));

function entityLabel(value) {
  if (entityNames[value]) return entityNames[value];
  const match = /^experience\.internships\.(\d+)$/.exec(value);
  if (match) {
    const internship = profile.internships?.[Number(match[1])];
    return `实习 ${Number(match[1]) + 1}${internship ? ` · ${internship.companyZh || internship.company || "未命名公司"}` : ""}`;
  }
  return `已有主体（${value}）`;
}
function entityOptions(memory) {
  const values = [...new Set([...Object.keys(entityNames), ...(profile.internships || []).map((_, index) => `experience.internships.${index}`), memory.entityId || "self"])];
  return values.map((value) => `<option value="${escape(value)}" ${value === (memory.entityId || "self") ? "selected" : ""}>${escape(entityLabel(value))}</option>`).join("");
}
function memoryCard(memory) {
  const scoped = memory.scope !== "global";
  const reusable = memory.confirmed && (!scoped || memory.scopeVersion === MEMORY_SCOPE_VERSION);
  return `<article class="memory-card" data-id="${escape(memory.id)}">
    <header><h2>${escape(memory.contextPath || memory.question)}</h2><button data-delete>删除</button></header>
    <p class="answer-text">${escape(memory.answer)}</p>
    <p class="memory-meta">${reusable ? "已确认，可在适用范围内复用" : "待核对，确认后才可复用"} · ${memory.language === "en" ? "英文" : "中文"} · ${escape(entityLabel(memory.entityId || "self"))} · ${scoped ? "仅指定申请链接" : "通用答案"}</p>
    ${scoped ? `<p class="scope-link">${escape(memory.scope || "尚未设置申请链接")}</p>` : ""}
    <details><summary>核对 / 修改复用设置</summary>
      <label>问题 <input data-question value="${escape(memory.question)}"></label>
      <label>答案 <textarea data-answer rows="4">${escape(memory.answer)}</textarea></label>
      <div class="field-grid"><label>语言 <select data-language><option value="zh" ${memory.language === "zh" ? "selected" : ""}>中文</option><option value="en" ${memory.language === "en" ? "selected" : ""}>英文</option></select></label>
      <label>这是谁的信息 <select data-entity>${entityOptions(memory)}</select></label></div>
      <label>适用范围 <select data-scope-kind><option value="page" ${scoped ? "selected" : ""}>仅指定申请链接</option><option value="global" ${scoped ? "" : "selected"}>通用答案</option></select></label>
      <label data-scope-label ${scoped ? "" : "hidden"}>申请链接 <input data-scope type="url" value="${escape(scoped ? memory.scope : "")}" placeholder="粘贴这个岗位的完整申请链接"></label>
      <p>岗位编号和页面路径会保留，登录凭据及跟踪参数会移除。选择通用答案表示允许跨岗位复用。</p>
      <button data-save class="cleanup-button">确认并保存</button><p>此操作只更新问答记忆，不修改个人信息。</p>
    </details></article>`;
}
async function render() {
  [memories, profile] = await Promise.all([getMemories(), getProfile()]);
  const query = $("searchInput").value.trim().toLowerCase();
  const shown = memories.filter((m) => `${m.question} ${m.answer} ${m.scope} ${entityLabel(m.entityId || "self")}`.toLowerCase().includes(query));
  $("memoryList").innerHTML = shown.length ? shown.map(memoryCard).join("") : '<p class="empty">暂无匹配的问答。可以在申请助手中读取、核对并保存网页答案。</p>';
  $("refreshMemories").hidden = true;
}
$("searchInput").addEventListener("input", run(render));
$("refreshMemories").addEventListener("click", run(render));
$("memoryList").addEventListener("change", (event) => {
  if (event.target.matches("[data-scope-kind]")) event.target.closest(".memory-card").querySelector("[data-scope-label]").hidden = event.target.value === "global";
});
$("memoryList").addEventListener("click", run(async (event) => {
  const card = event.target.closest("[data-id]");
  if (!card || saving) return;
  const memory = memories.find((entry) => entry.id === card.dataset.id);
  if (!memory) return;
  saving = true;
  try {
    if (event.target.matches("[data-delete]")) {
      if (!confirm(`删除“${memory.question}”这条问答？`)) return;
      await deleteMemory(memory.id); tell("已删除这条问答。");
    } else if (event.target.matches("[data-save]")) {
      const scope = card.querySelector("[data-scope-kind]").value === "global" ? "global" : scopeFor(card.querySelector("[data-scope]").value.trim());
      if (!scope) throw new Error("请粘贴有效的申请链接");
      const expected = Object.fromEntries(["question", "answer", "language", "entityId", "scope", "updatedAt"].filter((key) => Object.hasOwn(memory, key)).map((key) => [key, memory[key]]));
      await saveMemory({ ...memory, question: card.querySelector("[data-question]").value.trim(), answer: card.querySelector("[data-answer]").value.trim(), language: card.querySelector("[data-language]").value, entityId: card.querySelector("[data-entity]").value, scope }, expected);
      tell("已确认保存。个人信息保持原样。");
    } else return;
    await render();
  } finally { saving = false; }
}));

function downloadBackup(backup) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `application-tracker-backup-${toDateInputValue()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("exportBackup").addEventListener("click", run(async () => {
  downloadBackup(await requestStorageMutation({ operation: "backup.export" }));
  tell("已导出投递记录、个人资料与问答记忆；备份不包含 API Key。");
}));
async function refreshRecovery() {
  const recovery = await requestStorageMutation({ operation: "backup.recovery" });
  $("restoreRecovery").hidden = !recovery;
  if (recovery) $("restoreRecovery").title = `恢复点时间：${new Date(recovery.exportedAt).toLocaleString()}`;
}
async function showBackupPreview() {
  if (!pendingBackup) return;
  const revision = ++previewRevision;
  $("confirmRestore").disabled = true; preview = null;
  const next = await requestStorageMutation({ operation: "backup.preview", backup: pendingBackup, mode: $("restoreMode").value });
  if (revision !== previewRevision) return;
  preview = next; $("backupPreview").hidden = false;
  $("backupSummary").textContent = `${next.partial ? "旧版资料备份（不含投递记录）" : "完整备份"} · ${new Date(next.exportedAt).toLocaleString()}。备份包含 ${next.incomingRecords} 条投递、${next.incomingMemories} 条问答和 ${next.incomingLegacy} 条旧问答；恢复后共 ${next.resultRecords} 条投递、${next.resultMemories} 条问答。`;
  $("restoreDescription").textContent = next.mode === "replace"
    ? `${next.partial ? "替换个人资料与问答，保留现有投递记录。" : "用此备份替换全部投递记录、个人资料与问答。"}恢复前会在本机保存一个完整恢复点。`
    : `合并时，相同 ID 保留现有内容（本次 ${next.conflictCount} 项）。${next.profileKept ? "当前已有个人资料，整份保留。" : "当前资料为空，将导入备份中的资料。"}${next.profileConflict ? "备份资料与当前资料不同，新加入的问答将设为待核对，避免经历对应错误。" : ""}恢复前会在本机保存一个完整恢复点。`;
  $("confirmRestore").disabled = false;
}
$("importBackup").addEventListener("change", run(async (event) => {
  const file = event.target.files?.[0]; event.target.value = "";
  if (!file) return;
  pendingBackup = null; preview = null; previewRevision++; $("backupPreview").hidden = true;
  if (file.size > MAX_BACKUP_BYTES) throw new Error("备份文件超过 20 MB，请选择插件导出的 JSON 备份");
  let value; try { value = JSON.parse(await file.text()); } catch { throw new Error("无法读取 JSON，请选择插件导出的备份文件"); }
  validateBackup(value);
  pendingBackup = value; $("restoreMode").value = "merge"; await showBackupPreview();
}));
$("restoreMode").addEventListener("change", run(showBackupPreview));
$("refreshPreview").addEventListener("click", run(showBackupPreview));
$("cancelRestore").addEventListener("click", () => { pendingBackup = null; preview = null; previewRevision++; $("backupPreview").hidden = true; });
$("restoreRecovery").addEventListener("click", run(async () => {
  pendingBackup = await requestStorageMutation({ operation: "backup.recovery" });
  if (!pendingBackup) throw new Error("当前没有导入前恢复点");
  $("restoreMode").value = "replace"; await showBackupPreview(); $("backupPreview").scrollIntoView({ behavior: "smooth" });
}));
$("confirmRestore").addEventListener("click", run(async () => {
  if (!pendingBackup || !preview || saving) return;
  saving = true; $("confirmRestore").disabled = true;
  try {
    await requestStorageMutation({ operation: "backup.import", backup: pendingBackup, mode: preview.mode, currentVersion: preview.currentVersion });
    pendingBackup = null; preview = null; $("backupPreview").hidden = true;
    await render(); await refreshRecovery();
    tell("恢复完成。导入前的资料已保存在本机，可点击“导入前恢复点”再次预览并恢复。");
  } catch (error) {
    preview = null; throw new Error(`${error.message}。请点击“重新预览”核对后继续。`);
  } finally { saving = false; }
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[RECOVERY_KEY]) refreshRecovery().catch((error) => tell(error.message));
  if (!changes[MEMORY_KEY] || saving) return;
  if ($("memoryList").querySelector("details[open]")) { $("refreshMemories").hidden = false; tell("问答已在另一页面更新。当前编辑内容已保留，保存时会检查冲突；也可刷新列表。"); }
  else render().catch((error) => tell(error.message));
});
run(async () => { await render(); await refreshRecovery(); })();
