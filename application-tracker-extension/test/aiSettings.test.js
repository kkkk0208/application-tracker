import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AI_SETTINGS, normalizeAiSettings } from "../src/aiSettings.js";

test("normalizeAiSettings keeps AI disabled by default", () => {
  assert.deepEqual(normalizeAiSettings(), DEFAULT_AI_SETTINGS);
});

test("normalizeAiSettings trims key and preserves explicit settings", () => {
  assert.deepEqual(normalizeAiSettings({
    enabled: true,
    apiKey: " sk-test ",
    model: " gpt-4.1-mini "
  }), {
    enabled: true,
    visionEnabled: false,
    apiKey: "sk-test",
    model: "gpt-4.1-mini"
  });
});

test("screenshots require an explicit saved opt-in and survive settings normalization", () => {
  assert.equal(normalizeAiSettings({ enabled: true }).visionEnabled, false);
  assert.equal(normalizeAiSettings({ visionEnabled: "true" }).visionEnabled, false);
  assert.equal(normalizeAiSettings({ enabled: true, visionEnabled: true }).visionEnabled, true);
  assert.equal(normalizeAiSettings({ enabled: false, visionEnabled: true }).enabled, false);
});

test("normalizeAiSettings falls back to default model", () => {
  assert.equal(normalizeAiSettings({ enabled: true, apiKey: "sk-test", model: "" }).model, DEFAULT_AI_SETTINGS.model);
});

test("normalization repairs the legacy default model typo without changing chosen models", () => {
  assert.equal(normalizeAiSettings({ model: "gpt-5_5" }).model, "gpt-5.5");
  assert.equal(normalizeAiSettings({ model: "gpt-4.1-mini" }).model, "gpt-4.1-mini");
});
