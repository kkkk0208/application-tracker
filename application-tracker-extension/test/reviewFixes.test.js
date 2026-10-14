import test from "node:test";
import assert from "node:assert/strict";
import { cleanPortalUrl, createRecord, updateRecord, validateRecordForSave } from "../src/model.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createBackup } from "../src/backup.js";
import { recordsToDisplayRows, workbookToImportedRecords } from "../src/excel.js";
import { buildRecordDraft } from "../src/assistant/recordDraft.js";

const base = { company: "示例公司", role: "审计实习生", source: "referral", appliedDate: "2026-10-12", status: "applied" };

test("new records clean manual URLs and hash credentials while old records remain unchanged on status edits", () => {
  const dirty = "https://user:pass@careers.example/apply?jobId=8&ticket=secret#/job/8?access_token=secret&round=1";
  const cleaned = "https://careers.example/apply?jobId=8#/job/8?round=1";
  assert.equal(cleanPortalUrl(dirty), cleaned);
  assert.equal(createRecord({ ...base, portalLink: dirty }).portalLink, cleaned);
  const old = { ...createRecord({ ...base, portalLink: "微信内推" }), portalLink: dirty };
  assert.equal(updateRecord(old, { status: "oa" }).portalLink, dirty);
  assert.equal(updateRecord(old, { portalLink: dirty }).portalLink, cleaned);
  assert.equal(cleanPortalUrl("https://careers.example/apply#access_token=secret"), "https://careers.example/apply");
});

test("real bundled SheetJS date cells import as date serials without timezone drift", () => {
  const exports = {};
  runInNewContext(readFileSync(new URL("../vendor/xlsx.full.min.js", import.meta.url), "utf8"), { exports, module: { exports }, Buffer, Date, ArrayBuffer, Uint8Array, setTimeout, clearTimeout });
  assert.ok(exports.read && exports.write, "The bundled Excel runtime must exist in source and public packages");
  const record = createRecord({ ...base, portalLink: "https://example.com/job/1" });
  const row = recordsToDisplayRows([record])[0];
  const headers = Object.keys(row), dateColumn = headers.indexOf("下次跟进");
  const sheet = exports.utils.aoa_to_sheet([headers, headers.map((key) => row[key])]);
  sheet[exports.utils.encode_cell({ r: 1, c: dateColumn })] = { t: "n", v: Date.UTC(2026, 9, 20) / 86400000 + 25569, z: "yyyy-mm-dd" };
  const workbook = exports.utils.book_new(); exports.utils.book_append_sheet(workbook, sheet, "投递记录");
  const bytes = exports.write(workbook, { type: "buffer", bookType: "xlsx" });
  const imported = workbookToImportedRecords(exports.read(bytes, { type: "buffer", cellDates: false }), (sheet) => exports.utils.sheet_to_json(sheet, { defval: "" }));
  assert.equal(imported[0].nextActionDate, "2026-10-20");
});

test("plain-text application references with a colon are kept as text", () => {
  for (const link of ["Referral: Alice", "Email: hr@example.com", "WeChat:abc123", "mailto:hr@example.com", "内推：张三", "微信内推"]) {
    assert.equal(validateRecordForSave({ ...base, portalLink: link }).portalLink, undefined, link);
    assert.equal(createRecord({ ...base, portalLink: link }).portalLink, link);
  }
  for (const link of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/x", "https://", "JavaScript :alert(1)"]) {
    assert.match(validateRecordForSave({ ...base, portalLink: link }).portalLink || "", /http/, link);
  }
});

test("an existing English text reference no longer blocks backup", () => {
  const record = { ...createRecord({ ...base, portalLink: "微信内推" }), portalLink: "Referral: Alice" };
  assert.doesNotThrow(() => createBackup({ records: [record] }));
});

test("stored application links drop login tickets and tracking but keep business parameters and routes", () => {
  assert.equal(cleanPortalUrl("https://campus.example.com/apply?jobId=88&token=abc&ticket=ST-1&utm_source=wechat&sign=x#/job/88"), "https://campus.example.com/apply?jobId=88#/job/88");
  assert.equal(cleanPortalUrl("微信内推"), "微信内推");
  assert.equal(buildRecordDraft({ url: "https://careers.example/jobs/1?token=temporary" }).portalLink, "https://careers.example/jobs/1");
});

test("a date typed in Excel keeps its calendar day in every time zone", () => {
  const record = createRecord({ ...base, portalLink: "https://example.com/job/1" });
  const [row] = recordsToDisplayRows([record]);
  const workbook = { SheetNames: ["投递记录"], Sheets: { 投递记录: {} } };
  // Local midnight, the few-minutes-early value SheetJS returns in China/Hong Kong, and UTC midnight.
  for (const value of [new Date(2026, 9, 20), new Date(2026, 9, 19, 23, 54, 17), new Date(Date.UTC(2026, 9, 20))]) {
    row["下次跟进"] = value;
    const [imported] = workbookToImportedRecords(workbook, () => [row]);
    assert.equal(imported.nextActionDate, "2026-10-20", value.toString());
  }
});
