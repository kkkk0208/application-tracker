import { createMutationQueue, MUTATION_MESSAGE } from "../storageMutations.js";

// The side panel owns long requests; session storage survives worker restarts.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let queue = Promise.resolve();
const mutate = createMutationQueue(chrome.storage.local);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === MUTATION_MESSAGE) {
    // Extension documents only: a content script runs on a third-party origin.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("src/"))) return;
    mutate(message.mutation).then((value) => respond({ ok: true, value }), (error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("src/sidepanel/"))) return;
  if (!["assistant-lock", "assistant-release"].includes(message.type)) return;
  queue = queue.catch(() => {}).then(async () => {
    const key = `applicationTracker.assistant.lock.${message.tabId}`;
    const data = await chrome.storage.session.get(key);
    const lock = data[key];
    if (message.type === "assistant-lock") {
      if (lock && lock.owner !== message.owner && lock.expires > Date.now()) return { ok: false };
      await chrome.storage.session.set({ [key]: { owner: message.owner, expires: Date.now() + 90000 } });
    } else if (lock?.owner === message.owner) await chrome.storage.session.remove(key);
    return { ok: true };
  });
  queue.then(respond, () => respond({ ok: false }));
  return true;
});
