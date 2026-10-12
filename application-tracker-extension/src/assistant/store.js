import { requestStorageMutation } from "../storageClient.js";
import { MEMORY_KEY } from "../storageKeys.js";

export { MEMORY_KEY };
const keyFor = (windowId) => `applicationTracker.assistant.session.${windowId}`;
export async function getMemories() {
  const data = await chrome.storage.local.get(MEMORY_KEY);
  if (Array.isArray(data[MEMORY_KEY])) return data[MEMORY_KEY];
  return requestStorageMutation({ operation: "memory.ensure" });
}
export async function saveMemory(draft, expected) {
  return requestStorageMutation({ operation: "memory.save", draft, expected });
}
export async function deleteMemory(id) {
  return requestStorageMutation({ operation: "memory.delete", id });
}
export async function saveSession(windowId, session) {
  await chrome.storage.session.set({ [keyFor(windowId)]: session });
}
export async function loadSession(windowId) {
  const data = await chrome.storage.session.get(keyFor(windowId));
  return data[keyFor(windowId)] || null;
}
