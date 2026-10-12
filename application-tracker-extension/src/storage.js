import { AI_PROFILE_MEMORY_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY, PROFILE_STORAGE_KEY, QUESTION_MEMORY_STORAGE_KEY, STORAGE_KEY } from "./constants.js";
import { normalizeProfileMemory } from "./aiProfileMemory.js";
import { normalizeAiSettings } from "./aiSettings.js";
import { normalizeProfile } from "./profile.js";
import { buildQuestionMemoryEntry } from "./questionMemory.js";
import { requestStorageMutation } from "./storageClient.js";

export async function getRecords() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

export async function saveNewRecord(draft) {
  return requestStorageMutation({ operation: "record.create", draft });
}

export async function saveExistingRecord(id, changes, expected) {
  return requestStorageMutation({ operation: "record.patch", id, changes, expected });
}

export async function deleteRecord(id) {
  return requestStorageMutation({ operation: "record.delete", id });
}

export async function replaceAllRecords(records) {
  return requestStorageMutation({ operation: "records.replace", records });
}

export async function getProfile() {
  const data = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
  return normalizeProfile(data[PROFILE_STORAGE_KEY]);
}

export async function saveProfile(profile) {
  return requestStorageMutation({ operation: "profile.save", value: profile });
}

export async function getQuestionMemories() {
  const data = await chrome.storage.local.get(QUESTION_MEMORY_STORAGE_KEY);
  const memories = Array.isArray(data[QUESTION_MEMORY_STORAGE_KEY]) ? data[QUESTION_MEMORY_STORAGE_KEY] : [];
  return memories.map((memory) => buildQuestionMemoryEntry(memory, memory.updatedAt));
}

export async function learnQuestionMemories(entries) {
  return requestStorageMutation({ operation: "legacy.learn", entries });
}

export async function replaceQuestionMemories(memories) {
  return requestStorageMutation({ operation: "legacy.replace", memories });
}

export async function deleteQuestionMemory(id) {
  return requestStorageMutation({ operation: "legacy.delete", id });
}

export async function getAiSettings() {
  const data = await chrome.storage.local.get(AI_SETTINGS_STORAGE_KEY);
  return normalizeAiSettings(data[AI_SETTINGS_STORAGE_KEY]);
}

export async function saveAiSettings(settings) {
  return requestStorageMutation({ operation: "aiSettings.save", value: settings });
}

export async function getAiProfileMemory() {
  const data = await chrome.storage.local.get(AI_PROFILE_MEMORY_STORAGE_KEY);
  return normalizeProfileMemory(data[AI_PROFILE_MEMORY_STORAGE_KEY]);
}

export async function saveAiProfileMemory(memory) {
  return requestStorageMutation({ operation: "aiProfile.save", value: memory });
}
