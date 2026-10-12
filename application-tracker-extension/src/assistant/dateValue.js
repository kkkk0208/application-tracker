// Month-only facts retain their precision unless a caller explicitly permits a day.
export function parseDateValue(value, format = "") {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  let parts;
  if (/^d/i.test(format)) {
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (match) parts = [Number(match[3]), Number(match[2]), Number(match[1])];
  }
  if (!parts) {
    const match = /^(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2})\s*日?)?\s*月?$/.exec(text);
    if (!match) return null;
    parts = [Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : null];
  }
  const [year, month, day] = parts;
  if (year < 1 || month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day !== null && (day < 1 || day > days)) return null;
  return { year, month, day };
}

export function formatDateValue(value, format = "", { allowDefaultDay = false } = {}) {
  const parsed = parseDateValue(value, format);
  if (!parsed) return "";
  const output = format || (parsed.day === null ? "YYYY-MM" : "YYYY-MM-DD");
  if (/[dD]/.test(output) && parsed.day === null && !allowDefaultDay) return "";
  return output.replace(/YYYY|yyyy|MM|DD|dd|M|D|d/g, (part) => {
    if (/y/i.test(part)) return String(parsed.year).padStart(4, "0");
    const number = part.includes("M") ? parsed.month : parsed.day ?? 1;
    return part.length === 2 ? String(number).padStart(2, "0") : String(number);
  });
}

export function dateFormatFor(field) {
  if (field.dateFormat) return field.dateFormat;
  if (field.type === "month") return "YYYY-MM";
  if (field.type === "date") return "YYYY-MM-DD";
  const placeholder = field.placeholder || "";
  return placeholder.match(/(?:YYYY|yyyy)[-/.年]MM(?:[-/.月](?:DD|dd)日?|月)?/)?.[0] || "";
}

export function validateDateValue(field, value) {
  let values = [value];
  if (field.dateRange) {
    try { values = JSON.parse(value); } catch { return "请填写开始、结束日期组成的数组"; }
    if (!Array.isArray(values) || values.length !== 2) return "请填写完整的开始、结束日期";
  }
  const format = dateFormatFor(field);
  for (const item of values) {
    const parsed = parseDateValue(item, format);
    if (!parsed || (/[dD]/.test(format) && parsed.day === null)) return "需要完整且有效的日期，不能补造未知的日";
    if (format && formatDateValue(item, format) !== item) return `需要 ${format} 格式`;
  }
  if (field.dateRange) {
    const canonical = values.map((item) => {
      const date = parseDateValue(item, format);
      return date.year * 10000 + date.month * 100 + (date.day ?? 1);
    });
    if (canonical[0] > canonical[1]) return "结束日期不能早于开始日期";
  }
  return "";
}
