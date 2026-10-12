const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateInputValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function classifyNextActionDate(nextActionDate, today = toDateInputValue()) {
  if (!nextActionDate) return "none";

  const target = parseLocalDate(nextActionDate);
  const current = parseLocalDate(today);
  if (!target || !current) return "none";

  const diffDays = Math.round((target.getTime() - current.getTime()) / DAY_MS);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 3) return "upcoming";
  return "none";
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateInputValue(date) === value ? date : null;
}
