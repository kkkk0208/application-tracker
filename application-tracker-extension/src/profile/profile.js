import { getProfile, saveProfile } from "../storage.js";

const form = document.querySelector("#profileForm");
const message = document.querySelector("#message");
const internshipLists = {
  zh: document.querySelector("#zhInternshipList"),
  en: document.querySelector("#enInternshipList")
};

init();

async function init() {
  setFormValues(await getProfile());
  form.addEventListener("submit", handleSubmit);
  form.addEventListener("click", handleFormClick);
  form.addEventListener("input", handleFormInput);
  bindMirrorInputs();
  document.querySelectorAll(".profile-tab").forEach((button) => {
    button.addEventListener("click", () => switchProfileTab(button.dataset.profileTab));
  });
}

async function handleSubmit(event) {
  event.preventDefault();
  try {
    await saveProfile(getFormValues());
    message.textContent = "已保存，申请助手会自动使用最新资料";
  } catch (error) { message.textContent = `保存失败：${error.message}`; }
  message.hidden = false;
}

function handleFormClick(event) {
  const addButton = event.target.closest("button[data-action='add-internship']");
  if (addButton) {
    addInternshipPair();
    return;
  }

  const removeButton = event.target.closest("button[data-action='remove-internship']");
  if (removeButton) {
    const card = removeButton.closest(".internship-card");
    removeInternshipPair(Number(card?.dataset.internshipIndex || 0));
  }
}

function handleFormInput(event) {
  const input = event.target.closest("[data-internship-field='period']");
  if (!input) return;

  const card = input.closest(".internship-card");
  const language = card?.dataset.internshipLanguage;
  const index = card?.dataset.internshipIndex;
  const otherLanguage = language === "zh" ? "en" : "zh";
  const otherInput = internshipLists[otherLanguage]?.querySelector(
    `.internship-card[data-internship-index="${index}"] [data-internship-field="period"]`
  );
  if (otherInput && otherInput.value !== input.value) otherInput.value = input.value;
}

function switchProfileTab(tab) {
  document.querySelectorAll(".profile-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.profileTab === tab);
  });
  document.querySelectorAll("[data-profile-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.profilePanel !== tab;
  });
}

function setFormValues(values) {
  for (const [key, value] of Object.entries(values)) {
    if (form.elements[key]) {
      form.elements[key].value = value;
    }
  }

  setMirrorValues(values);
  setCommonAnswerValues(values.commonAnswers || {});
  renderInternships(Array.isArray(values.internships) ? values.internships : []);
}

function setMirrorValues(values) {
  const mirrors = {
    phoneMirror: values.phone,
    emailMirror: values.email,
    linkedinMirror: values.linkedin,
    githubMirror: values.github,
    websiteMirror: values.website,
    masterStartDateMirror: values.masterStartDate,
    masterGraduationDateMirror: values.masterGraduationDate,
    bachelorStartDateMirror: values.bachelorStartDate,
    bachelorGraduationDateMirror: values.bachelorGraduationDate
  };
  for (const [key, value] of Object.entries(mirrors)) {
    if (form.elements[key]) form.elements[key].value = value || "";
  }
}

function setCommonAnswerValues(commonAnswers) {
  commonAnswerInputs().forEach((input) => {
    const field = input.dataset.commonAnswer;
    const language = input.dataset.commonLanguage;
    input.value = commonAnswers[field]?.[language] || "";
  });
}

function bindMirrorInputs() {
  [
    ["phone", "phoneMirror"],
    ["email", "emailMirror"],
    ["linkedin", "linkedinMirror"],
    ["github", "githubMirror"],
    ["website", "websiteMirror"],
    ["masterStartDate", "masterStartDateMirror"],
    ["masterGraduationDate", "masterGraduationDateMirror"],
    ["bachelorStartDate", "bachelorStartDateMirror"],
    ["bachelorGraduationDate", "bachelorGraduationDateMirror"]
  ].forEach(([leftName, rightName]) => {
    const left = form.elements[leftName];
    const right = form.elements[rightName];
    if (!left || !right) return;
    left.addEventListener("input", () => {
      right.value = left.value;
    });
    right.addEventListener("input", () => {
      left.value = right.value;
    });
  });
}

function getFormValues() {
  return {
    fullName: form.elements.fullName.value,
    fullNameZh: form.elements.fullNameZh.value,
    englishName: form.elements.englishName.value,
    phone: valueFrom("phoneMirror", "phone"),
    email: valueFrom("emailMirror", "email"),
    masterUniversity: form.elements.masterUniversity.value,
    masterUniversityZh: form.elements.masterUniversityZh.value,
    masterDegree: form.elements.masterDegree.value,
    masterDegreeZh: form.elements.masterDegreeZh.value,
    masterMajor: form.elements.masterMajor.value,
    masterMajorZh: form.elements.masterMajorZh.value,
    masterStartDate: valueFrom("masterStartDateMirror", "masterStartDate"),
    masterGraduationDate: valueFrom("masterGraduationDateMirror", "masterGraduationDate"),
    bachelorUniversity: form.elements.bachelorUniversity.value,
    bachelorUniversityZh: form.elements.bachelorUniversityZh.value,
    bachelorDegree: form.elements.bachelorDegree.value,
    bachelorDegreeZh: form.elements.bachelorDegreeZh.value,
    bachelorMajor: form.elements.bachelorMajor.value,
    bachelorMajorZh: form.elements.bachelorMajorZh.value,
    bachelorStartDate: valueFrom("bachelorStartDateMirror", "bachelorStartDate"),
    bachelorGraduationDate: valueFrom("bachelorGraduationDateMirror", "bachelorGraduationDate"),
    internships: getInternshipValues(),
    commonAnswers: getCommonAnswerValues(),
    linkedin: valueFrom("linkedinMirror", "linkedin"),
    github: valueFrom("githubMirror", "github"),
    website: valueFrom("websiteMirror", "website")
  };
}

function getCommonAnswerValues() {
  const commonAnswers = {};
  commonAnswerInputs().forEach((input) => {
    const field = input.dataset.commonAnswer;
    const language = input.dataset.commonLanguage;
    commonAnswers[field] ||= { zh: "", en: "" };
    commonAnswers[field][language] = input.value;
  });
  return commonAnswers;
}

function commonAnswerInputs() {
  return Array.from(form.querySelectorAll("[data-common-answer][data-common-language]"));
}

function valueFrom(primaryName, fallbackName) {
  return form.elements[primaryName]?.value || form.elements[fallbackName]?.value || "";
}

function renderInternships(internships) {
  internshipLists.zh.innerHTML = "";
  internshipLists.en.innerHTML = "";
  const values = internships.length > 0 ? internships : [{}];
  values.forEach(addInternshipPair);
}

function addInternshipPair(value = {}) {
  internshipLists.zh.append(createInternshipCard(value, "zh"));
  internshipLists.en.append(createInternshipCard(value, "en"));
  renumberInternships();
}

function createInternshipCard(value, language) {
  const card = document.createElement("section");
  card.className = "internship-card";
  card.dataset.internshipLanguage = language;

  if (language === "zh") {
    card.innerHTML = `
      <div class="internship-header">
        <h3>实习</h3>
        <button class="remove-internship-button" type="button" data-action="remove-internship">删除</button>
      </div>
      <div class="field-grid">
        <label>公司 <input data-internship-field="companyZh" value="${escapeAttribute(value.companyZh)}" /></label>
        <label>职位 <input data-internship-field="roleZh" value="${escapeAttribute(value.roleZh)}" /></label>
        <label>时间 <input data-internship-field="period" value="${escapeAttribute(value.period)}" placeholder="2025.06 - 2025.08" /></label>
        <label>经历 <textarea data-internship-field="descriptionZh">${escapeHtml(value.descriptionZh)}</textarea></label>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="internship-header">
        <h3>Internship</h3>
        <button class="remove-internship-button" type="button" data-action="remove-internship">Remove</button>
      </div>
      <div class="field-grid">
        <label>Company <input data-internship-field="company" value="${escapeAttribute(value.company)}" /></label>
        <label>Role <input data-internship-field="role" value="${escapeAttribute(value.role)}" /></label>
        <label>Period <input data-internship-field="period" value="${escapeAttribute(value.period)}" placeholder="2025.06 - 2025.08" /></label>
        <label>Experience <textarea data-internship-field="description">${escapeHtml(value.description)}</textarea></label>
      </div>
    `;
  }

  return card;
}

function removeInternshipPair(index) {
  if (!index) return;
  for (const list of Object.values(internshipLists)) {
    list.querySelector(`.internship-card[data-internship-index="${index}"]`)?.remove();
  }
  if (internshipLists.zh.children.length === 0) addInternshipPair();
  renumberInternships();
}

function getInternshipValues() {
  const zhCards = Array.from(internshipLists.zh.querySelectorAll(".internship-card"));
  const enCards = Array.from(internshipLists.en.querySelectorAll(".internship-card"));
  const count = Math.max(zhCards.length, enCards.length);

  return Array.from({ length: count }, (_, index) => {
    const zhCard = zhCards[index];
    const enCard = enCards[index];
    return {
      company: fieldValue(enCard, "company"),
      companyZh: fieldValue(zhCard, "companyZh"),
      role: fieldValue(enCard, "role"),
      roleZh: fieldValue(zhCard, "roleZh"),
      period: fieldValue(enCard, "period") || fieldValue(zhCard, "period"),
      description: fieldValue(enCard, "description"),
      descriptionZh: fieldValue(zhCard, "descriptionZh")
    };
  });
}

function fieldValue(card, field) {
  return card?.querySelector(`[data-internship-field="${field}"]`)?.value || "";
}

function renumberInternships() {
  for (const [language, list] of Object.entries(internshipLists)) {
    Array.from(list.querySelectorAll(".internship-card")).forEach((card, index) => {
      const number = index + 1;
      card.dataset.internshipIndex = String(number);
      card.querySelector("h3").textContent = language === "zh" ? `实习 ${number}` : `Internship ${number}`;
    });
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
