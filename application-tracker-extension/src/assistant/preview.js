import { validateValue } from "./planner.js";
import { sameQuestion } from "./reconcile.js";

// This only chooses which existing answers appear in the confirmation batch.
// Fact generation, safety classification and value validation remain upstream.
export function isFillable(item) {
  if (!item?.supported || item.value || typeof item.answer !== "string" || !item.answer.trim()) return false;
  if (item.kind === "custom-select") {
    if (item.optionError || !Array.isArray(item.options) || !item.options.length) return false;
    // Actual inspected options have opaque IDs; free text is not evidence that
    // the website offers an option, even when it matches a profile fact.
    if (item.options.some((option) => typeof option.id !== "string" || !option.id || typeof option.text !== "string")) return false;
  }
  return !validateValue(item, item.answer);
}

export function finalizePreview(plan, previous = []) {
  const previousById = new Map(previous.map((item) => [item.fieldId, item]));
  return plan.map((item) => {
    const previousItem = previousById.get(item.fieldId);
    const same = previousItem && sameQuestion(previousItem, item);
    // An explicit current choice wins. Otherwise inherit a prior opt-out only
    // while the document, question, entity and options still identify one item.
    const choice = Object.hasOwn(item, "selectionExplicit") ? item : same ? previousItem : null;
    const selectionExplicit = choice?.selectionExplicit === true;
    const optedOut = selectionExplicit && choice.selected === false;
    const reviewOptIn = item.requiresSelection === true && !item.edited && !selectionExplicit;
    return { ...item, selectionExplicit, selected: isFillable(item) && !optedOut && !reviewOptIn };
  });
}

export function previewStats(plan) {
  return plan.reduce((stats, item) => {
    const eligible = isFillable(item);
    const selected = eligible && item.selected === true;
    if (eligible) stats.eligible++;
    if (selected) stats.selected++;
    if (selected && item.status !== "ready") stats.review++;
    if (item.value) stats.filled++;
    else if (!eligible) stats.missing++;
    return stats;
  }, { eligible: 0, selected: 0, review: 0, missing: 0, filled: 0 });
}
