import { buildApplicationInfoGroups } from "../applicationInfo.js";
import { getBulkSelectionState, getSelectedVisibleIds, toggleAllVisibleIds } from "../bulk.js";
import { DEFAULT_SOURCE, DEFAULT_STATUS, SOURCES, STATUSES, STORAGE_KEY, PROFILE_STORAGE_KEY } from "../constants.js";
import { classifyNextActionDate, toDateInputValue } from "../dateUtils.js";
import { findPotentialDuplicate } from "../duplicates.js";
import { buildPreImportBackupFilename, buildWorkbookSheets, rowsToImportedRecords } from "../excel.js";
import { emptyRecordDraft, validateRecordForSave } from "../model.js";
import { getCompanyInitial, getStatusTone, summarizeRecords } from "../presentation.js";
import { deleteRecord, getProfile, getRecords, replaceAllRecords, saveExistingRecord, saveNewRecord } from "../storage.js";

const recordsBody = document.querySelector("#recordsBody");
const summaryLine = document.querySelector("#summaryLine");
const selectAllCheckbox = document.querySelector("#selectAllCheckbox");
const bulkToolbar = document.querySelector("#bulkToolbar");
const bulkCount = document.querySelector("#bulkCount");
const bulkStatusSelect = document.querySelector("#bulkStatusSelect");
const searchInput = document.querySelector("#searchInput");
const statusFilter = document.querySelector("#statusFilter");
const message = document.querySelector("#message");
const dialog = document.querySelector("#recordDialog");
const dialogTitle = document.querySelector("#dialogTitle");
const editForm = document.querySelector("#editForm");
const editErrors = document.querySelector("#editErrors");
const historyList = document.querySelector("#historyList");
const recordsPanel = document.querySelector("#recordsPanel");
const applicationInfoPanel = document.querySelector("#applicationInfoPanel");
const applicationInfoList = document.querySelector("#applicationInfoList");

let records = [];
let sortKey = "appliedDate";
let sortDirection = "desc";
let visibleRecords = [];
let selectedIds = new Set();
let editBaseline = null;

init();

async function init() {
  fillFilter();
  fillSelect(bulkStatusSelect, STATUSES);
  fillSelect(editForm.elements.source, SOURCES);
  fillSelect(editForm.elements.status, STATUSES);
  records = await getRecords();
  render();

  searchInput.addEventListener("input", render);
  statusFilter.addEventListener("change", render);
  document.querySelectorAll(".sort-button").forEach((button) => {
    button.addEventListener("click", () => changeSort(button.dataset.sort));
  });
  recordsBody.addEventListener("click", handleTableClick);
  recordsBody.addEventListener("change", handleTableChange);
  selectAllCheckbox.addEventListener("change", handleSelectAllChange);
  document.querySelector("#bulkStatusButton").addEventListener("click", handleBulkStatusUpdate);
  document.querySelector("#bulkDeleteButton").addEventListener("click", handleBulkDelete);
  editForm.addEventListener("submit", handleEditSubmit);
  document.querySelector("#cancelEditButton").addEventListener("click", () => dialog.close());
  document.querySelector("#newRecordButton").addEventListener("click", openNewRecordDialog);
  document.querySelector("#exportButton").addEventListener("click", handleExport);
  document.querySelector("#importInput").addEventListener("change", handleImport);
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  applicationInfoList.addEventListener("click", handleApplicationInfoClick);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) {
      records = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
      selectedIds = new Set([...selectedIds].filter((id) => records.some((record) => record.id === id)));
      render();
    }
    if (changes[PROFILE_STORAGE_KEY] && !applicationInfoPanel.hidden) renderApplicationInfo().catch((error) => showMessage(error.message));
  });
}

function render() {
  renderSummary();
  visibleRecords = getVisibleRecords();
  recordsBody.innerHTML = visibleRecords.map(renderRow).join("");
  renderBulkControls();
}

async function switchTab(tab) {
  const isApplicationInfo = tab === "applicationInfo";
  recordsPanel.hidden = isApplicationInfo;
  applicationInfoPanel.hidden = !isApplicationInfo;
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (isApplicationInfo) await renderApplicationInfo();
}

async function renderApplicationInfo() {
  const groups = buildApplicationInfoGroups(await getProfile());
  if (groups.length === 0) {
    applicationInfoList.innerHTML = `
      <section class="application-info-empty">
        <p>还没有个人信息。</p>
        <a class="primary-action" href="../profile/profile.html" target="_blank">去填写</a>
      </section>
    `;
    return;
  }
  applicationInfoList.innerHTML = groups.map(renderApplicationInfoGroup).join("");
}

function renderApplicationInfoGroup(group) {
  return `
    <section class="application-info-group">
      <h3>${escapeHtml(group.title)}</h3>
      ${group.sections.map(renderApplicationInfoSection).join("")}
    </section>
  `;
}

function renderApplicationInfoSection(section) {
  return `
    <section class="application-info-card">
      <header><h3>${escapeHtml(section.title)}</h3></header>
      ${renderApplicationInfoItems(section)}
    </section>
  `;
}

function renderApplicationInfoItems(section) {
  if (section.entries?.length) {
    return section.entries.map((entry) => `
      <div class="application-info-entry">
        <h4>${escapeHtml(entry.title || "实习经历")}</h4>
        <dl>${entry.items.map(renderCopyableItem).join("")}</dl>
      </div>
    `).join("");
  }
  return `<dl>${section.items.map(renderCopyableItem).join("")}</dl>`;
}

function renderCopyableItem(item) {
  return `
    <div>
      <dt>${escapeHtml(item.label)}</dt>
      <dd>${escapeHtml(item.value)}</dd>
      <button type="button" data-action="copy-item" data-copy-text="${escapeAttribute(item.copyText || item.value)}">复制</button>
    </div>
  `;
}

async function handleApplicationInfoClick(event) {
  const button = event.target.closest("button[data-action='copy-item']");
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.copyText || "");
  showMessage("已复制");
}

function getVisibleRecords() {
  return records
    .filter(matchesSearch)
    .filter(matchesStatus)
    .sort(compareRecords);
}

function renderRow(record) {
  const dueClass = classifyNextActionDate(record.nextActionDate, toDateInputValue());
  const statusTone = getStatusTone(record.status);
  const companyInitial = getCompanyInitial(record.company);
  return `
    <tr class="${dueClass === "none" ? "" : dueClass}">
      <td><input class="row-checkbox" type="checkbox" data-action="select" data-id="${record.id}" aria-label="选择 ${escapeAttribute(record.company)}" ${selectedIds.has(record.id) ? "checked" : ""} /></td>
      <td>
        <a class="company-link" href="${escapeAttribute(record.portalLink)}" target="_blank" rel="noreferrer">
          <span class="company-avatar">${escapeHtml(companyInitial)}</span>
          <span>${escapeHtml(record.company)}</span>
        </a>
      </td>
      <td>${escapeHtml(record.role)}</td>
      <td>${escapeHtml(record.base)}</td>
      <td>
        <select class="status-select status-${statusTone}" data-action="status" data-id="${record.id}" aria-label="修改 ${escapeAttribute(record.company)} 的状态">
          ${renderStatusOptions(record.status)}
        </select>
      </td>
      <td>${escapeHtml(record.appliedDate)}</td>
      <td>${escapeHtml(record.nextActionDate)}</td>
      <td>
        <button data-action="edit" data-id="${record.id}">编辑</button>
        <button data-action="delete" data-id="${record.id}">删除</button>
      </td>
    </tr>
  `;
}

function renderStatusOptions(selectedStatus) {
  return STATUSES.map((status) => {
    const selected = status.key === selectedStatus ? " selected" : "";
    return `<option value="${status.key}"${selected}>${status.label}</option>`;
  }).join("");
}

function renderSummary() {
  const summary = summarizeRecords(records);
  summaryLine.textContent = `共 ${summary.total} 条 · 进行中 ${summary.active} · Offer ${summary.offers} · 已拒 ${summary.rejected}`;
}

function matchesSearch(record) {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return true;
  return `${record.company} ${record.role}`.toLowerCase().includes(query);
}

function matchesStatus(record) {
  return !statusFilter.value || record.status === statusFilter.value;
}

function compareRecords(a, b) {
  const result = String(a[sortKey] || "").localeCompare(String(b[sortKey] || ""));
  return sortDirection === "asc" ? result : -result;
}

function changeSort(key) {
  if (sortKey === key) {
    sortDirection = sortDirection === "asc" ? "desc" : "asc";
  } else {
    sortKey = key;
    sortDirection = "desc";
  }
  render();
}

async function handleTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const record = records.find((item) => item.id === button.dataset.id);
  if (!record) return;

  if (button.dataset.action === "edit") {
    openEditDialog(record);
  }

  if (button.dataset.action === "delete") {
    if (!confirm(`确认删除 ${record.company} - ${record.role}？`)) return;
    await deleteRecord(record.id);
    records = await getRecords();
    showMessage("已删除。");
    render();
  }
}

async function handleTableChange(event) {
  const checkbox = event.target.closest("input[data-action='select']");
  if (checkbox) {
    if (checkbox.checked) selectedIds.add(checkbox.dataset.id);
    else selectedIds.delete(checkbox.dataset.id);
    renderBulkControls();
    return;
  }

  const select = event.target.closest("select[data-action='status']");
  if (!select) return;

  const record = records.find((item) => item.id === select.dataset.id);
  if (!record || record.status === select.value) return;

  try {
    await saveExistingRecord(record.id, { status: select.value });
    records = await getRecords();
    selectedIds.delete(record.id);
    showMessage("状态已更新。");
    render();
  } catch (error) {
    select.value = record.status;
    showMessage(`状态更新失败：${error.message}`);
  }
}

function handleSelectAllChange(event) {
  selectedIds = toggleAllVisibleIds(selectedIds, visibleRecords, event.target.checked);
  render();
}

async function handleBulkStatusUpdate() {
  const ids = selectedVisibleIds();
  if (ids.length === 0) return;
  const status = bulkStatusSelect.value;

  for (const id of ids) {
    const record = records.find((item) => item.id === id);
    if (record && record.status !== status) {
      await saveExistingRecord(id, { status });
    }
  }

  records = await getRecords();
  selectedIds = new Set();
  showMessage(`已批量更新 ${ids.length} 条状态。`);
  render();
}

async function handleBulkDelete() {
  const ids = selectedVisibleIds();
  if (ids.length === 0) return;
  if (!confirm(`确认删除选中的 ${ids.length} 条记录？`)) return;

  for (const id of ids) {
    await deleteRecord(id);
  }

  records = await getRecords();
  selectedIds = new Set();
  showMessage(`已批量删除 ${ids.length} 条记录。`);
  render();
}

function renderBulkControls() {
  const selectionState = getBulkSelectionState(selectedIds, visibleRecords);
  selectAllCheckbox.checked = selectionState.checked;
  selectAllCheckbox.indeterminate = selectionState.indeterminate;
  bulkToolbar.hidden = selectionState.count === 0;
  bulkCount.textContent = `已选择 ${selectionState.count} 条`;
}

function selectedVisibleIds() {
  return getSelectedVisibleIds(selectedIds, visibleRecords);
}

function openEditDialog(record) {
  editBaseline = structuredClone(record);
  dialogTitle.textContent = "编辑记录";
  setFormValues(record);
  historyList.innerHTML = (record.statusHistory || [])
    .map((item) => `<li>${escapeHtml(labelFor(STATUSES, item.status))}：${escapeHtml(item.date)}</li>`)
    .join("");
  editErrors.hidden = true;
  dialog.showModal();
}

function openNewRecordDialog() {
  editBaseline = null;
  dialogTitle.textContent = "新增投递";
  setFormValues({
    ...emptyRecordDraft(),
    id: "",
    source: DEFAULT_SOURCE,
    status: DEFAULT_STATUS,
    appliedDate: toDateInputValue()
  });
  historyList.innerHTML = "";
  editErrors.hidden = true;
  dialog.showModal();
}

async function handleEditSubmit(event) {
  event.preventDefault();
  const id = editForm.elements.id.value;
  const draft = getFormValues();
  const errors = validateRecordForSave(draft);
  if (Object.keys(errors).length > 0) {
    editErrors.innerHTML = Object.values(errors).map((error) => `<div>${escapeHtml(error)}</div>`).join("");
    editErrors.hidden = false;
    return;
  }

  const saveButton = document.querySelector("#saveEditButton");
  saveButton.disabled = true;
  try {
    if (id) {
      const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== (editBaseline?.[key] ?? "")));
      const expected = Object.fromEntries(Object.keys(changes).map((key) => [key, editBaseline?.[key] ?? ""]));
      if (Object.keys(changes).length) await saveExistingRecord(id, changes, expected);
    } else {
      const duplicate = findPotentialDuplicate(draft, records);
      if (duplicate && !confirm(buildDuplicateMessage(duplicate))) return;
      await saveNewRecord(draft);
    }
    records = await getRecords();
    dialog.close();
    showMessage(id ? "已保存修改。" : "已新增投递。");
    render();
  } catch (error) {
    editErrors.textContent = `保存失败：${error.message}`;
    editErrors.hidden = false;
  } finally { saveButton.disabled = false; }
}

function fillFilter() {
  statusFilter.innerHTML = [
    `<option value="">全部状态</option>`,
    ...STATUSES.map((status) => `<option value="${status.key}">${status.label}</option>`)
  ].join("");
}

function fillSelect(select, options) {
  select.innerHTML = options
    .map((option) => `<option value="${option.key}">${option.label}</option>`)
    .join("");
}

function setFormValues(record) {
  for (const [key, value] of Object.entries(record)) {
    if (editForm.elements[key]) {
      editForm.elements[key].value = value ?? "";
    }
  }
}

function getFormValues() {
  return {
    company: editForm.elements.company.value,
    role: editForm.elements.role.value,
    base: editForm.elements.base.value,
    portalLink: editForm.elements.portalLink.value,
    pageTitle: editForm.elements.pageTitle.value,
    source: editForm.elements.source.value,
    appliedDate: editForm.elements.appliedDate.value,
    status: editForm.elements.status.value,
    nextActionDate: editForm.elements.nextActionDate.value,
    jdText: editForm.elements.jdText.value,
    notes: editForm.elements.notes.value
  };
}

function labelFor(options, key) {
  return options.find((option) => option.key === key)?.label || key || "";
}

function buildDuplicateMessage(duplicate) {
  const reason = duplicate.reason === "portalLink" ? "链接相同" : "公司和岗位相同";
  return `可能已记录过这条投递（${reason}）：${duplicate.record.company} - ${duplicate.record.role}\n\n仍然保存吗？`;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
}

function handleExport() {
  try {
    assertXlsxLoaded();
    downloadRecordsAsXlsx(records, `application-records-${toDateInputValue()}.xlsx`);
    showMessage("已导出 Excel。");
  } catch (error) {
    showMessage(`导出失败：${error.message}`);
  }
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!confirm("导入会覆盖当前本地记录。确认继续？")) return;

  try {
    assertXlsxLoaded();
    if (records.length > 0) {
      downloadRecordsAsXlsx(records, buildPreImportBackupFilename(toDateInputValue()));
    }
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames.includes("_restore_data")
      ? "_restore_data"
      : workbook.SheetNames.includes("_data")
        ? "_data"
        : workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
    const imported = rowsToImportedRecords(rows);
    await replaceAllRecords(imported);
    records = await getRecords();
    showMessage("已导入并覆盖本地记录。");
    render();
  } catch (error) {
    showMessage(`导入失败：${error.message}`);
  }
}

function downloadRecordsAsXlsx(recordsToDownload, filename) {
  const sheets = buildWorkbookSheets(recordsToDownload);
  const workbook = XLSX.utils.book_new();
  const workbookSheetMetadata = [];

  for (const sheet of sheets) {
    const worksheet = XLSX.utils.json_to_sheet(sheet.rows);
    if (sheet.type === "display") applyDisplayWorksheetLayout(worksheet);
    else applyRawWorksheetLayout(worksheet);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
    workbookSheetMetadata.push({ name: sheet.name, Hidden: sheet.hidden });
  }

  workbook.Workbook = { Sheets: workbookSheetMetadata };
  XLSX.writeFile(workbook, filename);
}

function applyDisplayWorksheetLayout(worksheet) {
  worksheet["!cols"] = [
    { wch: 18 },
    { wch: 28 },
    { wch: 16 },
    { wch: 22 },
    { wch: 12 },
    { wch: 12 },
    { wch: 18 },
    { wch: 46 },
    { wch: 36 },
    { wch: 42 },
    { wch: 36 },
    { wch: 56 },
    { wch: 22 },
    { wch: 22 }
  ];
  worksheet["!autofilter"] = { ref: worksheet["!ref"] };
}

function applyRawWorksheetLayout(worksheet) {
  worksheet["!cols"] = [
    { wch: 38 },
    { wch: 18 },
    { wch: 28 },
    { wch: 16 },
    { wch: 46 },
    { wch: 36 },
    { wch: 18 },
    { wch: 12 },
    { wch: 18 },
    { wch: 56 },
    { wch: 12 },
    { wch: 42 },
    { wch: 36 },
    { wch: 22 },
    { wch: 22 }
  ];
}

function assertXlsxLoaded() {
  if (!globalThis.XLSX) {
    throw new Error("Excel 库未加载，请确认 vendor/xlsx.full.min.js 存在。");
  }
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
