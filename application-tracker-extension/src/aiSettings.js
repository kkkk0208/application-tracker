export const DEFAULT_AI_SETTINGS = {
  enabled: false,
  visionEnabled: false,
  apiKey: "",
  model: "gpt-5.5"
};

export function normalizeAiSettings(settings = {}) {
  const model = stringValue(settings.model);
  return {
    enabled: Boolean(settings.enabled),
    visionEnabled: settings.visionEnabled === true,
    apiKey: stringValue(settings.apiKey),
    model: model === "gpt-5_5" ? DEFAULT_AI_SETTINGS.model : model || DEFAULT_AI_SETTINGS.model
  };
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}
