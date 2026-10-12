const UNSAFE_TYPES = new Set(["hidden", "password", "file", "submit", "button", "reset"]);

export function buildQuestionMemoryEntry(draft, now = new Date().toISOString()) {
  const question = cleanText(draft.question);
  const answer = cleanText(draft.answer);
  const section = cleanText(draft.section);
  const group = cleanText(draft.group);
  const contextPath = cleanText(draft.contextPath) || buildContextPath(section, group, question);
  return {
    id: draft.id || createId(),
    question,
    answer,
    section,
    group,
    contextPath,
    displayQuestion: contextPath || question,
    language: draft.language || detectLanguage(question),
    category: draft.category || categorizeQuestion(question),
    source: draft.source || "user_filled",
    pageUrl: cleanText(draft.pageUrl),
    createdAt: draft.createdAt || now,
    updatedAt: now,
    lastUsedAt: draft.lastUsedAt || ""
  };
}

export function extractFilledQuestionAnswers(fields) {
  return fields
    .filter(isSafeFilledField)
    .map((field) => withContextFields({
      question: bestQuestionText(field),
      answer: cleanText(field.value)
    }, field))
    .filter((pair) => pair.question && pair.answer);
}

export function mergeQuestionMemories(existing, incoming, now = new Date().toISOString()) {
  const merged = existing.map((entry) => buildQuestionMemoryEntry(entry, entry.updatedAt || now));

  for (const incomingEntry of incoming) {
    const normalizedIncoming = buildQuestionMemoryEntry(incomingEntry, now);
    const index = merged.findIndex((entry) => isSameMemorySlot(entry, normalizedIncoming));
    if (index === -1) {
      merged.push(normalizedIncoming);
    } else {
      merged[index] = {
        ...merged[index],
        question: normalizedIncoming.question,
        answer: normalizedIncoming.answer,
        section: normalizedIncoming.section,
        group: normalizedIncoming.group,
        contextPath: normalizedIncoming.contextPath,
        displayQuestion: normalizedIncoming.displayQuestion,
        language: normalizedIncoming.language,
        category: normalizedIncoming.category,
        pageUrl: normalizedIncoming.pageUrl || merged[index].pageUrl,
        updatedAt: now
      };
    }
  }

  return merged;
}

function isSameMemorySlot(a, b) {
  if (a.contextPath || b.contextPath) {
    return a.contextPath === b.contextPath;
  }
  return isSimilarQuestion(a.question, b.question);
}

function isSafeFilledField(field) {
  const type = cleanText(field.type || "text").toLowerCase();
  if (UNSAFE_TYPES.has(type)) return false;
  return Boolean(cleanText(field.value));
}

function bestQuestionText(field) {
  return cleanText(field.label || field.question || field.placeholder || field.name || field.id);
}

function isSimilarQuestion(a, b) {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const smaller = Math.min(aTokens.size, bTokens.size);
  return intersection / smaller >= 0.6;
}

function tokenSet(value) {
  return new Set(cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((token) => token.length > 2));
}

function detectLanguage(value) {
  return /[\u4e00-\u9fff]/.test(value) ? "zh" : "en";
}

function categorizeQuestion(value) {
  const text = cleanText(value).toLowerCase();
  if (/sponsor|visa|work authorization|right to work|合法工作|签证|簽證/.test(text)) return "work_authorization";
  if (/salary|compensation|expected pay|期望薪资|期望薪資|薪酬/.test(text)) return "salary";
  if (/start date|available|notice period|入职|入職|到岗|到崗/.test(text)) return "availability";
  if (/language|mandarin|cantonese|english|语言|語言|普通话|普通話|粤语|粵語/.test(text)) return "language";
  return "general";
}

function buildContextPath(section, group, question) {
  if (!section && !group) return "";
  return [section, group, question].filter(Boolean).join(" > ");
}

function withContextFields(pair, field) {
  const section = cleanText(field.section);
  const group = cleanText(field.group);
  const contextPath = cleanText(field.contextPath) || buildContextPath(section, group, pair.question);
  return {
    ...pair,
    ...(section ? { section } : {}),
    ...(group ? { group } : {}),
    ...(contextPath ? { contextPath } : {})
  };
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
