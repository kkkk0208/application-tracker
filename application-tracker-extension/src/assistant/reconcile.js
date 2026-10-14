// Preserve drafts only when both the browser document and the question still agree.
export function sameQuestion(left, right) {
  const identity = (item) => JSON.stringify([
    item.documentId, item.fieldId, item.label, item.kind, item.type,
    item.groupId, item.group, item.section, item.entityId, item.intent,
    item.constraints, (item.options || []).map(({ text, disabled }) => [text, !!disabled])
  ]);
  return identity(left) === identity(right);
}

export function reconcilePlan(previous, next) {
  const byId = new Map(previous.map((item) => [item.fieldId, item]));
  return next.map((item) => {
    const old = byId.get(item.fieldId);
    if (item.value || !item.supported) return { ...item, selected: false };
    if (old && sameQuestion(old, item)) {
      return { ...item, answer: old.answer, source: old.source, factIds: old.factIds,
        requiresSelection: old.requiresSelection, memoryId: old.memoryId ?? item.memoryId, memoryVersion: old.memoryVersion ?? item.memoryVersion,
        edited: old.edited, selected: false,
        status: old.answer ? old.status === "ready" && !old.edited ? "ready" : "review" : item.status,
        reason: old.answer ? "已保留原答案，预览后统一确认填写" : item.reason };
    }
    return { ...item, selected: false, status: item.answer ? "review" : item.status,
      reason: item.visualGroupUnresolved ? item.reason : old ? "题目或选项已变化，请重新核对" : "新出现的问题，请核对后选中" };
  });
}

export function entityLabel(entity = "self") {
  const labels = { self: "本人", "education.master": "硕士教育", "education.bachelor": "本科教育",
    "education.unknown": "教育经历（待指定）", "experience.unknown": "实习经历（待指定）",
    "family.father": "父亲", "family.mother": "母亲", "family.unknown": "家庭成员（待指定）" };
  if (labels[entity]) return labels[entity];
  const match = /^experience\.[^.]+\.(\d+)$/.exec(entity);
  return match ? `实习经历 ${Number(match[1]) + 1}` : "其他资料主体";
}
