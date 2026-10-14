import { interpretField } from "./planner.js";

// Semantic memory reuse is relaxed only for open prose. Short factual questions
// keep their exact-meaning checks even when a site renders them as textareas.
export function isOpenTextQuestion(item) {
  if (!item?.label?.trim() || /^(?:未命名问题|请选择|请输入|unnamed question)$/i.test(item.label.trim())) return false;
  if (!item?.supported || item.value || !(item.narrative || item.kind === "textarea")
    || item.options?.length || item.datePart || item.dateRange || !item.entityId || item.entityId.includes("unknown")) return false;
  const meaning = interpretField(item, [], { [item.groupId]: item.entityId });
  const intent = meaning.ruleConfidence === "high" ? meaning.intent : item.ruleConfidence === "high" ? item.intent : "";
  return !intent || /(?:common_answer\.(?:whyRole|whyCompany|selfIntroduction)|\.description)$/.test(intent);
}
