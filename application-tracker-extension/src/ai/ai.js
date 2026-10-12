import { getAiSettings, saveAiSettings } from "../storage.js";

const form = document.querySelector("#aiSettingsForm");
const message = document.querySelector("#message");

init();

async function init() {
  setFormValues(await getAiSettings());
  form.addEventListener("submit", handleSubmit);
}

async function handleSubmit(event) {
  event.preventDefault();
  await saveAiSettings(getFormValues());
  message.textContent = "已保存";
  message.hidden = false;
}

function setFormValues(settings) {
  form.elements.enabled.checked = settings.enabled;
  form.elements.visionEnabled.checked = settings.visionEnabled;
  form.elements.apiKey.value = settings.apiKey;
  form.elements.model.value = settings.model;
}

function getFormValues() {
  return {
    enabled: form.elements.enabled.checked,
    visionEnabled: form.elements.visionEnabled.checked,
    apiKey: form.elements.apiKey.value,
    model: form.elements.model.value
  };
}
