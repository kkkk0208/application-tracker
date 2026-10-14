import { validateValue } from "./planner.js";
import { isFillable, previewStats } from "./preview.js";

export function groupOf(item, latestResult, facts = []) {
  if (item.value) return "filled";
  if (!item.supported) return "web";
  if (latestResult && latestResult.status !== "verified" && !latestResult.undone) return "attention";
  const answer = typeof item.answer === "string" && item.answer.trim();
  const unknown = (item.entityId || "").includes("unknown");
  if (answer && (item.status === "review" || ["placeholder", "none"].includes(item.labelSource)
    || validateValue(item, item.answer) || unknown)) return "attention";
  if (isFillable(item) && item.status === "ready") return "ready";
  const kind = /^(education|experience)\./.exec(item.entityId || "")?.[1];
  if (!answer && (item.constraints?.required || unknown && kind && facts.some(f => f.entityId?.startsWith(kind + ".")))) return "attention";
  return "optional";
}

export function buildPanelView(plan = [], results = [], facts = []) {
  const latest = new Map(results.map(result => [result.fieldId, result]));
  const groups = { attention: [], ready: [], web: [], optional: [], filled: [] };
  for (const item of plan) groups[groupOf(item, latest.get(item.fieldId), facts)].push(item);
  const sections = new Map();
  for (const item of groups.ready) {
    const name = item.section || "当前页面";
    sections.set(name, (sections.get(name) || 0) + 1);
  }
  return { groups, counts: { fill: previewStats(plan).selected, attention: groups.attention.length,
    skip: groups.web.length + groups.optional.length + (results.length ? 0 : groups.filled.length) },
    readySections: [...sections].map(([name, count]) => ({ name, count })) };
}

export function detectPageLanguage(snapshot = {}) {
  const text = [snapshot.title, ...(snapshot.fields || []).map(field => field.label)].join(" ");
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-z]/gi) || []).length;
  return !han && !latin || han / (han + latin) >= 0.3 ? "zh" : "en";
}
