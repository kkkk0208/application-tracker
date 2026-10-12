import { BOARD_COLUMNS, groupRecordsForBoard } from "../board.js";
import { STATUSES, STORAGE_KEY } from "../constants.js";
import { classifyNextActionDate, toDateInputValue } from "../dateUtils.js";
import { getCompanyInitial, getStatusTone, summarizeRecords } from "../presentation.js";
import { getRecords, saveExistingRecord } from "../storage.js";

const boardView = document.querySelector("#boardView");
const summaryLine = document.querySelector("#summaryLine");
const searchInput = document.querySelector("#searchInput");
const statusFilter = document.querySelector("#statusFilter");
const message = document.querySelector("#message");

let records = [];

init();

async function init() {
  fillFilter();
  records = await getRecords();
  render();

  searchInput.addEventListener("input", render);
  statusFilter.addEventListener("change", render);
  boardView.addEventListener("change", handleStatusChange);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    records = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
    render();
  });
}

function render() {
  renderSummary();
  const visibleRecords = getVisibleRecords();
  const grouped = groupRecordsForBoard(visibleRecords);
  boardView.innerHTML = BOARD_COLUMNS.map((column) => renderColumn(column, grouped[column.key])).join("");
}

function renderSummary() {
  const summary = summarizeRecords(records);
  summaryLine.textContent = `共 ${summary.total} 条 · 进行中 ${summary.active} · Offer ${summary.offers} · 已拒 ${summary.rejected}`;
}

function getVisibleRecords() {
  return records
    .filter(matchesSearch)
    .filter(matchesStatus)
    .sort((a, b) => (b.nextActionDate || b.appliedDate || "").localeCompare(a.nextActionDate || a.appliedDate || ""));
}

function renderColumn(column, columnRecords) {
  return `
    <article class="board-column">
      <header class="board-column-header">
        <h2 class="board-column-title">${escapeHtml(column.label)}</h2>
        <span class="board-count">${columnRecords.length}</span>
      </header>
      <div class="board-card-list">
        ${columnRecords.map(renderCard).join("")}
      </div>
    </article>
  `;
}

function renderCard(record) {
  const dueClass = classifyNextActionDate(record.nextActionDate, toDateInputValue());
  const statusTone = getStatusTone(record.status);
  const companyInitial = getCompanyInitial(record.company);
  return `
    <article class="board-card ${dueClass === "none" ? "" : dueClass}">
      <div class="board-card-title">
        <span class="company-avatar">${escapeHtml(companyInitial)}</span>
        <a href="${escapeAttribute(record.portalLink)}" target="_blank" rel="noreferrer">${escapeHtml(record.company)}</a>
      </div>
      <p class="board-card-role">${escapeHtml(record.role)}</p>
      <div class="board-card-meta">
        <span>Base：${escapeHtml(record.base || "-")}</span>
        <span>投递：${escapeHtml(record.appliedDate || "-")}</span>
        <span>跟进：${escapeHtml(record.nextActionDate || "-")}</span>
      </div>
      <select class="status-select status-${statusTone}" data-action="status" data-id="${record.id}" aria-label="修改 ${escapeAttribute(record.company)} 的状态">
        ${renderStatusOptions(record.status)}
      </select>
    </article>
  `;
}

function renderStatusOptions(selectedStatus) {
  return STATUSES.map((status) => {
    const selected = status.key === selectedStatus ? " selected" : "";
    return `<option value="${status.key}"${selected}>${status.label}</option>`;
  }).join("");
}

async function handleStatusChange(event) {
  const select = event.target.closest("select[data-action='status']");
  if (!select) return;

  const record = records.find((item) => item.id === select.dataset.id);
  if (!record) return;
  if (record.status === select.value) return;

  try {
    await saveExistingRecord(record.id, { status: select.value });
    records = await getRecords();
    showMessage("状态已更新。");
    render();
  } catch (error) {
    select.value = record.status;
    showMessage(`状态更新失败：${error.message}`);
  }
}

function fillFilter() {
  statusFilter.innerHTML = [
    `<option value="">全部状态</option>`,
    ...STATUSES.map((status) => `<option value="${status.key}">${status.label}</option>`)
  ].join("");
}

function matchesSearch(record) {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return true;
  return `${record.company} ${record.role}`.toLowerCase().includes(query);
}

function matchesStatus(record) {
  return !statusFilter.value || record.status === statusFilter.value;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
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
  return escapeHtml(value || "#");
}
