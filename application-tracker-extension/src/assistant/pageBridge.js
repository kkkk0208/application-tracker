// Self-contained: Chrome serializes this function into the isolated content world.
export async function pageBridge(request) {
  const KEY = "__applicationAssistantV2";
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const norm = (v) => clean(v).normalize("NFKC").toLowerCase();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const problem = (code, reason, retryable = false) => Object.assign(new Error(reason), { code, retryable });
  async function until(probe, { timeout = 2200, stableFor = 0, guard = () => {} } = {}) {
    const end = performance.now() + timeout;
    let since = 0;
    let previous;
    while (performance.now() < end) {
      guard();
      const current = probe();
      if (current && current === previous) { if (performance.now() - since >= stableFor) return current; }
      else { previous = current; since = performance.now(); if (current && !stableFor) return current; }
      await wait(40);
    }
    return null;
  }
  const visible = (el) => !!el?.isConnected && !el.closest('[hidden], [inert], [aria-hidden="true"]') && [...el.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0) && getComputedStyle(el).visibility !== "hidden";
  const all = (selector, root = document) => {
    const result = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) result.push(...all(selector, host.shadowRoot));
    return result;
  };
  const state = globalThis[KEY] ||= { token: crypto.randomUUID(), nodes: new Map(), ids: new WeakMap(), sequence: 0, scanId: "", operations: new Map(), busy: false };
  const idFor = (node) => {
    if (!state.ids.has(node)) state.ids.set(node, `f${++state.sequence}`);
    return state.ids.get(node);
  };
    const placeholder = (text) => /^(请选择.*|选择.*|please select.*|select|choose|please choose.*)$/i.test(clean(text));
  const containerFor = (el) => el.closest('.form-item--phoenix, [class*="apply-field"]:not([class*="apply-fields"]), .form-item, .form-group, .ant-form-item, .el-form-item, [data-field], fieldset') || el.parentElement;
  const CONTROL_SEL = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), select, textarea, [role="combobox"], [contenteditable="true"]';
  const hasControl = (node) => !!(node.matches?.(CONTROL_SEL) || node.querySelector?.(CONTROL_SEL));
  const GENERIC_HINT = /^(请输入|请选择|请填写|请选择日期|选择日期|请输入内容|选择|输入|please (enter|select|choose)\b.*|select|choose|enter|checkbox-group|radio-group)$/i;
  const cleanQ = (t) => clean(t).replace(/^[*＊\s]+/, "").replace(/\s*[*＊]\s*$/, "").replace(/\s*[:：]\s*$/, "").replace(/\s*[*＊]\s*$/, "").trim();
  const labelLike = (node) => {
    if (!node || node.nodeType !== 1 || !visible(node) || hasControl(node)) return "";
    const t = cleanQ(node.textContent);
    return t && t.length <= 60 && !/^(请输入|请选择|请选择日期|选择日期)$/.test(t) ? t : "";
  };
  function questionFor(el, skipOwnLabel = false) {
    const root = el.getRootNode();
    const aria = cleanQ((el.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id)?.textContent).filter(Boolean).join(" ") || el.getAttribute?.("aria-label") || "");
    if (aria && !GENERIC_HINT.test(aria)) return { text: aria, source: "aria" };
    if (!skipOwnLabel && el.labels?.length) {
      const own = cleanQ([...el.labels].map((n) => n.textContent).join(" "));
      if (own && !GENERIC_HINT.test(own)) return { text: own, source: "label" };
    }
    const box = el.closest('.ant-form-item, .el-form-item, .ivu-form-item, .arco-form-item, .t-form__item, .layui-form-item, .form-item--phoenix, .form-group');
    const known = box?.querySelector('.ant-form-item-label, .el-form-item__label, .ivu-form-item-label, .arco-form-label-item, .t-form__label, .layui-form-label, .form-item__text, label.control-label');
    if (known && cleanQ(known.textContent)) return { text: cleanQ(known.textContent), source: "container" };
    const cell = el.closest("td, th");
    if (cell) for (let prev = cell.previousElementSibling; prev; prev = prev.previousElementSibling) {
      const t = labelLike(prev); if (t) return { text: t, source: "table" };
      if (hasControl(prev)) break;
    }
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 6; depth++, node = node.parentElement) {
      let steps = 0;
      for (let prev = node.previousElementSibling; prev && steps < 3; prev = prev.previousElementSibling, steps++) {
        // A real heading marks a section boundary, never the question of the next control.
        if (hasControl(prev) || prev.matches("h1, h2, h3, h4, h5, h6, legend")) break;
        const t = labelLike(prev); if (t) return { text: t, source: "nearby" };
      }
    }
    const ph = cleanQ(el.getAttribute?.("placeholder") || el.querySelector?.("[placeholder]")?.getAttribute("placeholder") || "");
    if (ph && !GENERIC_HINT.test(ph)) return { text: ph, source: "placeholder" };
    return { text: "", source: "none" };
  }
  const TITLE_CLASS = /(^|[-_\s])(module-title|form-tit|settitle|section-title|block-title|group-title|title|tit|heading|caption)($|[-_\s])/i;
  const classOf = (n) => typeof n.className === "string" ? n.className : n.className?.baseVal || "";
  function titleLike(node) {
    if (!node || node.nodeType !== 1 || !visible(node) || hasControl(node) || node.matches("td, th, label") || /label/i.test(classOf(node))) return "";
    const pool = [node, ...node.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[class*="title"],[class*="Title"],[class*="tit"]')]
      .filter((n) => n.matches("h1,h2,h3,h4,h5,h6,legend") || TITLE_CLASS.test(classOf(n)))
      .map((n) => cleanQ(n.textContent)).filter((t) => t.length <= 30 && /[\u4e00-\u9fa5A-Za-z]{2,}/.test(t));
    return pool.sort((a, b) => a.length - b.length)[0] || "";
  }
  function sectionFor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      let steps = 0;
      for (let prev = node.previousElementSibling; prev && steps < 12; prev = prev.previousElementSibling, steps++) {
        const t = titleLike(prev); if (t) return t;
      }
    }
    return "";
  }
  const signatureOf = (n) => n.tagName + "." + [...n.classList].filter((c) => !/active|open|hover|focus|error|checked|selected|first|last|^on$/i.test(c)).sort().join(".");
  function blockFor(el) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const parent = node.parentElement; if (!parent) break;
      const peers = [...parent.children].filter((c) => signatureOf(c) === signatureOf(node) && c.querySelector(CONTROL_SEL));
      if (peers.length < 2) continue;
      const questions = new Set([...node.querySelectorAll(CONTROL_SEL)].slice(0, 12).map((c) => questionFor(["radio", "checkbox"].includes(c.type) ? c.closest('.ant-radio-group,.ant-checkbox-group,.el-radio-group,.el-checkbox-group,[role="radiogroup"],[role="group"]') || containerFor(c) : c, ["radio", "checkbox"].includes(c.type)).text).filter(Boolean));
      if (questions.size >= 2) return { index: peers.indexOf(node) + 1, key: idFor(parent) };
    }
    return { index: 1, key: "" };
  }
  function labelFor(el) {
    const root = el.getRootNode();
    const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id)?.textContent).filter(Boolean).join(" ");
    const own = labelled || el.getAttribute("aria-label") || [...(el.labels || [])].map((n) => n.textContent).join(" ");
    if (clean(own)) return clean(own);
    const box = containerFor(el);
    return clean(box?.querySelector('.form-item__text, .ant-form-item-label, .el-form-item__label, [class*="field-label"], label, legend')?.textContent || el.getAttribute("placeholder") || el.name || "未命名问题");
  }
  function context(el) {
    const group = el.closest('fieldset, [data-experience], [data-education], [class*="experience-item"], [class*="education-item"], [class*="relation-item"]');
    const section = el.closest('section, [role="group"], [class*="form-section"], [class*="complete-form"], form');
    const nearestHeading = (() => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        for (let previous = node.previousElementSibling; previous; previous = previous.previousElementSibling) {
          if (previous.matches('h1, h2, h3, h4, legend, [data-group-label]')) return clean(previous.textContent);
        }
      }
      return "";
    })();
    const evidence = [
      { source: "label", text: labelFor(el) },
      { source: "group", text: clean(group?.querySelector("legend, h2, h3, h4, [data-group-label]")?.textContent) },
      { source: "section", text: clean(section?.querySelector("h1, h2, h3, legend, [data-section-label]")?.textContent) },
      { source: "nearby-heading", text: nearestHeading }
    ].filter((item) => item.text).map((item) => ({ ...item, text: item.text.slice(0, 240) }));
    const entity = (text) => /父亲|母亲|父母|家庭|亲属|紧急联系人|family|father|mother|emergency contact/i.test(text) ? "family" : /教育|学校|大学|学位|学历|education|university|degree/i.test(text) ? "education" : /工作|实习|雇主|employment|work experience|internship/i.test(text) ? "employment" : "";
    const ownEntity = entity(evidence.find((item) => item.source === "label")?.text || "");
    const groupEntities = evidence.filter((item) => item.source !== "label").map((item) => entity(item.text)).filter(Boolean);
    const conflicts = ownEntity === "family" && groupEntities.some((item) => item !== "family") || groupEntities.includes("family") && groupEntities.some((item) => item !== "family");
    const block = blockFor(el);
    const sectionTitle = clean(section?.querySelector("h1, h2, h3, legend, [data-section-label]")?.textContent) || sectionFor(el);
    return {
      groupIndex: block.index, blockKey: block.key,
      groupId: block.key ? `${block.key}:${block.index}` : group ? idFor(group) : section ? idFor(section) : "page",
      group: clean(group?.querySelector("legend, h2, h3, h4, [data-group-label]")?.textContent),
      section: sectionTitle,
      entityHint: ownEntity === "family" || groupEntities.includes("family") ? "family" : groupEntities[0] || ownEntity || "self",
      contextEvidence: evidence,
      contextConflicts: conflicts ? ["字段与周围分组的所属对象不一致，请核对"] : []
    };
  }
  function optionsFor(entry) {
    if (["custom-select", "cascader"].includes(entry.kind)) return entry.inspectedOptions || [];
    if (entry.kind === "choice") return entry.members.map((el) => ({ id: idFor(el), text: clean(el.textContent), value: el.getAttribute("data-value") || clean(el.textContent), disabled: el.getAttribute("aria-disabled") === "true" || el.matches(".disabled,.is-disabled") || !visible(el) }));
    if (entry.kind === "select") return [...entry.el.options].map((op) => ({ id: idFor(op), text: clean(op.textContent), value: op.value, disabled: op.disabled || placeholder(op.textContent) || !op.value }));
    if (["radio", "checkboxes"].includes(entry.kind)) return entry.members.map((el) => ({ id: idFor(el), text: labelFor(el), value: el.value, disabled: el.disabled || !(visible(el) || visible(el.closest("label"))) }));
    return [];
  }
  function nearbyText(el) {
    const box = containerFor(el) || el.parentElement;
    if (!box) return "";
    const texts = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],script,style,[data-private]')) continue;
      texts.push(node.textContent);
    }
    return clean(texts.join(" ")).slice(0, 160);
  }
  function choiceSelected(el) {
    return el.getAttribute("aria-checked") === "true" || [...el.classList].some((name) => /^(?:is-checked|active|selected|checked|on)$|(?:^|[-_])(?:active|selected|checked)$/.test(name));
  }
  function dateInputs(entry) {
    return entry.el.matches("input") ? [entry.el] : [...entry.el.querySelectorAll('input:not([type="hidden"])')];
  }
  function dateFormat(entry) {
    if (entry.adapter === "my97-date") return /dateFmt\s*:\s*['"]([^'"]+)['"]/.exec(entry.el.getAttribute("onclick") || "")?.[1] || "yyyy-MM-dd";
    const input = dateInputs(entry)[0];
    const format = entry.el.getAttribute("data-date-format") || input?.getAttribute("data-date-format") || input?.placeholder || "";
    if (/y{4}.*m{1,2}/i.test(format)) return format;
    if (input?.type === "month" || /month|月份|选择月|年月/i.test(`${classOf(entry.el)} ${format}`)) return "YYYY-MM";
    return "YYYY-MM-DD";
  }
  function dateParts(value) {
    const match = clean(value).match(/^(\d{4})[-/年](\d{1,2})(?:[-/月](\d{1,2}))?[月日]?$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = match[3] ? Number(match[3]) : null;
    if (year < 1 || month < 1 || month > 12 || (day !== null && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()))) return null;
    return { year, month, day };
  }
  function formatDate(value, format) {
    const parts = dateParts(value);
    if (!parts) throw problem("DATE_INVALID", "日期不存在或格式不正确");
    if (/d/i.test(format) && parts.day === null) throw problem("DATE_INCOMPLETE", "此日期需要具体到日，请核对资料");
    return format.replace(/yyyy|YYYY/g, String(parts.year)).replace(/MM/g, String(parts.month).padStart(2, "0")).replace(/dd|DD/g, String(parts.day).padStart(2, "0"));
  }
  function parseValues(value) {
    if (value === "") return [];
    let values;
    try { values = JSON.parse(value); } catch { values = [value]; }
    if (!Array.isArray(values)) values = [value];
    if (!values.every((item) => typeof item === "string")) throw problem("ANSWER_INVALID", "请按选项选择答案");
    return values;
  }
  function sameDate(actual, expected, entry) {
    if (!actual || !expected) return actual === expected;
    const left = parseValues(actual), right = parseValues(expected);
    if (left.length !== right.length) return false;
    return left.every((value, index) => {
      const a = dateParts(value), b = dateParts(right[index]);
      return a && b && a.year === b.year && a.month === b.month && (!/d/i.test(dateFormat(entry)) || (a.day ?? 1) === (b.day ?? 1));
    });
  }
  function read(entry) {
    const el = entry.el;
    if (entry.kind === "date") {
      const values = dateInputs(entry).map((input) => clean(input.value));
      return values.length > 1 ? (values.some(Boolean) ? JSON.stringify(values) : "") : values[0] || "";
    }
    if (entry.kind === "cascader") {
      const selected = el.querySelector('.ant-cascader-picker-label,.ant-select-selection-item');
      const input = el.querySelector('input:not([type="hidden"])');
      const text = clean(selected?.textContent || (entry.activeSearch?.el === input ? entry.activeSearch.baseline : input?.value));
      return placeholder(text) ? "" : text;
    }
    if (entry.kind === "choice") {
      const values = entry.members.filter(choiceSelected).map((member) => clean(member.textContent));
      return entry.multiple ? values.length ? JSON.stringify(values) : "" : values[0] || "";
    }
    if (entry.kind === "select") {
      const texts = [...el.selectedOptions].filter((op) => op.value && !placeholder(op.textContent)).map((op) => clean(op.textContent));
      return el.multiple ? (texts.length ? JSON.stringify(texts) : "") : texts[0] || "";
    }
    if (entry.kind === "radio") return entry.members.find((m) => m.checked) ? labelFor(entry.members.find((m) => m.checked)) : "";
    if (entry.kind === "checkboxes") {
      const texts = entry.members.filter((m) => m.checked).map(labelFor);
      return texts.length ? JSON.stringify(texts) : "";
    }
    if (entry.kind === "custom-select") {
      const selected = el.querySelector('.phoenix-select__value, .phoenix-select__single, [class*="singleValue"], .sd-Select-value, [class*="sd-Select-value"], [class*="selected-value"], .ant-select-selection-item, .ant-select-selection-selected-value');
      const input = el.matches("input") ? el : el.querySelector('input:not([type="hidden"])');
      if (el.querySelector(".phoenix-select__placeHolder--show")) return "";
      const queryInProgress = entry.activeSearch?.el === input && input?.value === entry.activeSearch.query;
      const text = clean(selected?.textContent || (queryInProgress ? entry.activeSearch.baseline : input?.value));
      return placeholder(text) ? "" : text;
    }
    return el.value || "";
  }
  function descriptor(entry) {
    const el = entry.el;
    const ctx = context(el);
    const groupBox = entry.members?.length > 1 ? entry.members.reduce((box, m) => { let b = box; while (b && !b.contains(m)) b = b.parentElement; return b; }, entry.members[0].parentElement) : null;
    const legend = entry.members?.length > 1 ? cleanQ(el.closest("fieldset, [role='radiogroup'], [role='group']")?.querySelector("legend, [data-question], .form-item__text")?.textContent) : "";
    const asked = legend ? { text: legend, source: "legend" } : groupBox ? questionFor(groupBox, true) : questionFor(el);
    const label = asked.text || (entry.members?.length > 1 ? "" : labelFor(el)) || "未命名问题";
    const input = el.matches("input, textarea, select") ? el : el.querySelector("input, textarea, select");
    const type = input?.type || entry.kind;
    const partHint = clean(input?.placeholder || el.querySelector('[class*="placeholder"], [class*="placeHolder"]')?.textContent || el.getAttribute("data-date-part"));
    const datePart = entry.datePart || (/^(year|年|年份)$/i.test(partHint) ? "year" : /^(month|月|月份)$/i.test(partHint) ? "month" : /^(day|日|日期中的日)$/i.test(partHint) ? "day" : "");
    const unsafe = ["password", "file", "hidden", "submit", "button", "reset"].includes(type) || /验证码|密码|captcha|verification code|one.time.password/i.test(label);
    const consent = /同意|承诺|声明|签名|隐私|consent|agree|declaration|signature|terms and conditions/i.test(label);
    const widget = ["date", "cascader", "custom-select"].includes(entry.kind);
    const disabled = Boolean(input?.disabled || (input?.readOnly && !widget) || el.matches('[aria-disabled="true"]'));
    const shown = visible(el) || (["radio", "checkboxes"].includes(entry.kind) && visible(el.closest("label")));
    const supported = !unsafe && !consent && !["unsupported", "chooser"].includes(entry.kind) && !disabled && shown;
    return {
      fieldId: idFor(el), ...ctx, label, kind: entry.kind, type, adapter: entry.adapter, datePart, dateGroupId: datePart ? idFor(containerFor(el)) : "",
      identity: { id: el.id || "", name: input?.name || "", autocomplete: input?.getAttribute("autocomplete") || "" },
      question: label, contextPath: [ctx.section, ctx.group, label].filter(Boolean).join(" > "),
      value: unsafe ? "" : read(entry), supported,
      reason: unsafe || consent ? "请在网站中手动处理" : entry.kind === "chooser" ? "需要在网页弹窗中选择，请手动处理" : disabled ? "字段只读或不可编辑" : !shown ? "字段已隐藏" : entry.kind === "unsupported" ? "此控件暂不支持自动填写" : "",
      labelSource: asked.source, order: entry.order ?? 0,
      nearbyText: ["placeholder", "none"].includes(asked.source) ? nearbyText(el) : "",
      dateFormat: entry.kind === "date" ? dateFormat(entry) : "", dateRange: entry.kind === "date" && dateInputs(entry).length > 1,
      options: optionsFor(entry), optionsQuery: entry.optionsQuery || "",
      constraints: { required: Boolean(input?.required || el.getAttribute("aria-required") === "true" || /[*＊]/.test(labelFor(el)) || el.closest('.ant-form-item-required,.is-required') || containerFor(el)?.querySelector('.ant-form-item-required')), maxLength: input?.maxLength > 0 ? input.maxLength : null, min: input?.min || "", max: input?.max || "", pattern: input?.pattern || "", multiple: !!input?.multiple || entry.kind === "checkboxes" || !!entry.multiple },
      help: clean(containerFor(el)?.querySelector('[class*="help"], [class*="hint"], [aria-live]')?.textContent).slice(0, 300)
    };
  }
  const signature = (field) => JSON.stringify([field.label, field.kind, field.type, field.groupId, field.group, field.section, field.constraints, field.options, field.datePart, field.dateFormat, field.dateRange, field.entityHint, field.contextEvidence, field.contextConflicts]);
  const semanticOptions = (options) => options.map(({ text, value, disabled }) => ({ text, value, disabled }));
  const fingerprint = (field) => JSON.stringify([field.label, field.kind, field.type, field.group, field.section, field.identity, field.constraints, semanticOptions(field.options), field.datePart, field.dateFormat, field.dateRange, field.entityHint, field.contextEvidence, field.contextConflicts]);
  function discover() {
    const entries = [];
    const claimed = new Set();
    const controls = all("input, textarea, select");
    const claimWidget = (selector, kind, adapter) => {
      for (const el of all(selector)) {
        if (!visible(el) || claimed.has(el) || entries.some((entry) => entry.el.contains(el) || el.contains(entry.el))) continue;
        entries.push({ el, kind, adapter });
        claimed.add(el);
        for (const child of el.querySelectorAll("input, select")) claimed.add(child);
      }
    };
    claimWidget('.ant-cascader-picker, .ant-select.ant-cascader, .el-cascader', "cascader", "cascader");
    claimWidget('.ant-calendar-picker, .ant-picker, .el-date-editor', "date", "picker-date");
    claimWidget('input.Wdate, input[onclick*="WdatePicker"]', "date", "my97-date");
    claimWidget('.magnify-glass', "chooser", "popup-chooser");
    for (const el of controls) if (/^showName/.test(el.id || el.name || "") && !claimed.has(el) && visible(el)) { entries.push({ el, kind: "chooser", adapter: "popup-chooser" }); claimed.add(el); }
    for (const el of all('.phoenix-select, .ant-select, .el-select, .sd-Select-container, [class*="sd-Select-container"], .sd-Dropdown-container, [class*="sd-Dropdown-container"], [role="combobox"]')) {
      if (!visible(el) || el.closest('[role="listbox"]') || el.tagName === "SELECT" || claimed.has(el)) continue;
      if (entries.some((entry) => entry.el.contains(el))) continue;
      entries.push({ el, kind: "custom-select", adapter: el.matches(".el-select") ? "element" : el.closest(".form-item--phoenix") ? "phoenix" : "custom" });
      claimed.add(el);
      for (const child of el.querySelectorAll("input, select")) claimed.add(child);
    }
    for (const el of all('[role="radio"],[role="checkbox"],[class*="radio"],[class*="check"],[class*="option"],[class*="tag"],[class*="choice"]')) {
      const safeChoice = (node) => node.matches('div,span,li,button[type="button"]') && !node.closest('a[href],button:not([type="button"])');
      if (!safeChoice(el) || !visible(el) || claimed.has(el) || el.querySelector("input") || entries.some((entry) => entry.el.contains(el)) || el.closest(menuSelector)) continue;
      const role = el.getAttribute("role");
      const scope = el.closest('[role="radiogroup"],[role="group"]') || el.parentElement;
      const members = role ? [...scope.querySelectorAll(`[role="${role}"]`)].filter((node) => safeChoice(node) && !node.querySelector("input") && visible(node))
        : [...(el.parentElement?.children || [])].filter((node) => safeChoice(node) && node.tagName === el.tagName && signatureOf(node) === signatureOf(el) && visible(node) && !node.querySelector("input") && clean(node.textContent).length > 0 && clean(node.textContent).length <= 40 && (node.matches("button,[tabindex],[onclick]") || getComputedStyle(node).cursor === "pointer"));
      if (members.length < 2 || members.some((member) => claimed.has(member))) continue;
      members.forEach((member) => claimed.add(member));
      entries.push({ el: members[0], members, multiple: role === "checkbox" || /check|multiple|multi-select/i.test(classOf(scope)), kind: "choice", adapter: "choice" });
    }
    for (const el of controls) {
      if (claimed.has(el) || (!visible(el) && !(["radio", "checkbox"].includes(el.type) && visible(el.closest("label")))) || ["hidden", "button", "submit", "reset"].includes(el.type)) continue;
      let kind = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : "text";
      let members;
      if (["radio", "checkbox"].includes(el.type)) {
        kind = el.type === "radio" ? "radio" : "checkboxes";
        const widgetGroup = el.closest('.ant-radio-group,.ant-checkbox-group,.el-radio-group,.el-checkbox-group,[role="radiogroup"],[role="group"]');
        const scope = widgetGroup || el.closest("fieldset") || el.form || el.getRootNode();
        members = controls.filter((other) => other.type === el.type && other.getRootNode() === el.getRootNode() && (el.name ? other.name === el.name && (other.form || null) === (el.form || null) && scope.contains(other) : widgetGroup ? widgetGroup.contains(other) : other === el));
        members.forEach((item) => claimed.add(item));
      }
      if (["date", "month"].includes(el.type)) kind = "date";
      entries.push({ el, kind, members, adapter: kind === "date" ? "native-date" : el.closest(".form-item--phoenix") ? "phoenix" : el.className?.includes("sd-Input") ? "moka" : "native" });
    }
    for (const el of all('[contenteditable="true"], [role="textbox"], [role="slider"], input[type="file"]')) {
      if (visible(el) && !entries.some((e) => e.el === el || e.el.contains(el))) entries.push({ el, kind: "unsupported", adapter: "unknown" });
    }
    entries.sort((a, b) => a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return entries;
  }
  function assertTarget() {
    if (request.token !== state.token || request.scanId !== state.scanId || request.url !== location.href) throw problem("PAGE_CHANGED", "页面已变化，请重新识别");
  }
  const fail = (reason, status = "failed", code = "CONTROL_FAILED", retryable = false) => ({ status, reason, code, retryable });
  function rebind(entry, expected) {
    assertTarget();
    const matches = discover().filter((candidate) => {
      candidate.inspectedOptions = entry.inspectedOptions;
      candidate.optionsQuery = entry.optionsQuery;
      return fingerprint(descriptor(candidate)) === fingerprint(entry.snapshot);
    });
    if (matches.length !== 1) throw problem(matches.length ? "AMBIGUOUS_REPLACEMENT" : "FIELD_REPLACED", matches.length ? "替换后的字段不唯一，请重新识别" : "原字段已被替换，未找到相同题目");
    const candidate = matches[0];
    if (!descriptor(candidate).supported || read(candidate) !== expected) throw problem("USER_EDITED", "替换后的字段已有内容或状态变化，保留原值");
    state.ids.set(candidate.el, request.fieldId);
    Object.assign(entry, candidate, { rebound: true });
    entry.snapshot = descriptor(entry);
    entry.signature = signature(entry.snapshot);
    return entry;
  }
  function resolve(requireWritable = true, expected) {
    assertTarget();
    const entry = state.nodes.get(request.fieldId);
    if (!entry) throw problem("FIELD_MISSING", "原字段已不存在，请重新识别");
    if (!entry.el.isConnected || entry.members?.some((el) => !el.isConnected)) rebind(entry, expected ?? entry.baseline);
    const current = descriptor(entry);
    if (signature(current) !== entry.signature || (requireWritable && !current.supported)) throw problem("FIELD_CHANGED", current.reason || "题目或选项已变化，请重新识别");
    return entry;
  }
  function transaction(entry, baseline) {
    const scope = { menu: null, userEdited: false, queryInput: null, queryValue: null, expected: baseline };
    const onEdit = (event) => {
      if (event.isTrusted && !scope.ownMutation && (entry.el === event.target || entry.el.contains(event.target) || entry.members?.some((member) => member === event.target || member.closest("label")?.contains(event.target)) || scope.menu?.contains(event.target) || (scope.opening && event.target.closest?.(menuSelectorFor(entry))))) scope.userEdited = true;
    };
    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("keydown", onEdit, true);
    document.addEventListener("pointerdown", onEdit, true);
    scope.act = (action) => { scope.ownMutation = true; try { return action(); } finally { scope.ownMutation = false; } };
    scope.guardStructure = (expected = scope.expected) => {
      assertTarget();
      if (scope.userEdited) throw problem("USER_EDITED", "操作期间检测到手动输入，已停止并保留网页内容");
      resolve(true, expected);
    };
    scope.guard = (expected = scope.expected) => {
      scope.guardStructure(expected);
      if (read(entry) !== expected) throw problem("VALUE_CHANGED", "操作期间网页内容发生变化，已停止并保留原值");
      if (scope.queryInput?.isConnected && scope.queryValue !== null && scope.queryInput.value !== scope.queryValue) throw problem("USER_EDITED", "搜索内容已变化，已停止操作");
    };
    scope.release = () => {
      for (const event of ["input", "change", "keydown", "pointerdown"]) document.removeEventListener(event, onEdit, true);
      delete entry.activeSearch;
    };
    return scope;
  }
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
function optionMatch(options, value, { location = false } = {}) {
  const text = (option) => typeof option === "string" ? option : option?.text ?? option?.label ?? option?.value ?? "";
  const normalize = (input) => {
    let result = typeof input === "string" ? input.normalize("NFKC").toLowerCase().replace(/\s+/g, "") : "";
    if (location) result = result.replace(/(?:(?:壮族|回族|维吾尔)?自治区|特别行政区|省|市|区|县)$/, "");
    return result;
  };
  const expected = normalize(value);
  if (!expected || !Array.isArray(options)) return null;
  const available = options.filter((option) => option != null && !option.disabled && normalize(text(option)));
  const unique = (matches) => matches.length === 1 ? matches[0] : null;
  let matches = available.filter((option) => text(option) === value);
  if (matches.length) return unique(matches);
  matches = available.filter((option) => normalize(text(option)) === expected);
  if (matches.length) return unique(matches);
  const groups = [
    ["男", "Male", "M", "先生"], ["女", "Female", "F", "女士"],
    ["本科", "大学本科", "学士", "Bachelor", "Undergraduate"],
    ["硕士", "硕士研究生", "研究生", "Master", "Postgraduate"],
    ["博士", "博士研究生", "PhD", "Doctor"], ["大专", "专科", "Associate"],
    ["学士学位", "学士", "Bachelor's degree"], ["硕士学位", "硕士", "Master's degree"],
    ["中共党员", "党员", "中国共产党党员"], ["中共预备党员", "预备党员"],
    ["共青团员", "团员"], ["未婚", "单身", "Single"], ["已婚", "Married"],
    ["汉族", "汉"], ["是", "Yes", "有"], ["否", "No", "无", "没有"],
    ["中国", "中国大陆", "中华人民共和国", "China", "CN"],
    ["中国香港", "香港", "Hong Kong", "Hong Kong SAR"], ["全日制", "统招", "Full-time"],
    ["大学英语六级", "英语六级", "CET-6", "CET6"], ["大学英语四级", "英语四级", "CET-4", "CET4"],
    ["雅思", "IELTS"], ["托福", "TOEFL"]
  ].map((group) => group.map(normalize));
  const related = groups.filter((group) => group.includes(expected));
  matches = available.filter((option) => related.some((group) => group.includes(normalize(text(option)))));
  if (matches.length) return unique(matches);
  // A substring cannot turn a categorical answer into a different category or
  // erase negation. Single letters and single Chinese characters are too weak.
  if (expected.length < 2 || related.length) return null;
  const negative = (input) => /不|无|否|未|没有|非/.test(input) || /\b(?:not|no|without|never)\b/i.test(input);
  matches = available.filter((option) => {
    const candidate = normalize(text(option));
    return candidate.length >= 2 && negative(value) === negative(text(option))
      && (candidate.includes(expected) || expected.includes(candidate));
  });
  return unique(matches);
}
  function exactOption(options, value, context = {}) {
    const match = optionMatch(options, value, context);
    if (!match) throw problem("OPTION_AMBIGUOUS", "未找到唯一匹配选项，请核对");
    return match;
  }
  function validation(entry) {
    const nodes = entry.members || [entry.el];
    if (nodes.some((el) => el.validity && !el.validity.valid)) return "网站拒绝该格式";
    const error = containerFor(entry.el)?.querySelector('[aria-invalid="true"], .ant-form-item-explain-error, .el-form-item__error, [data-error]');
    return error && visible(error) ? "网站显示字段校验错误" : "";
  }
  const menuSelector = '[role="listbox"], .common-unmodeled-layer, .phoenix-select-dropdown, .phoenix-select__dropdown, .sd-Menu, [class*="sd-Menu"], .ant-select-dropdown, .el-select-dropdown, .ant-cascader-menus, .ant-cascader-dropdown, .el-cascader__dropdown, .ant-calendar-picker-container, .ant-picker-dropdown, .el-picker-panel';
  const menuSelectorFor = (entry) => entry.kind === "date" ? '.ant-calendar-picker-container,.ant-picker-dropdown,.el-picker-panel' : entry.kind === "cascader" ? '.ant-cascader-menus,.ant-cascader-dropdown,.el-cascader__dropdown' : menuSelector;
  function currentMenu(entry) {
    const controlled = entry.el.getAttribute("aria-controls") || entry.el.querySelector("[aria-controls]")?.getAttribute("aria-controls");
    if (controlled) {
      const root = entry.el.getRootNode();
      const matches = [...new Set(controlled.split(/\s+/).map((id) => root.getElementById?.(id) || document.getElementById(id)).map((node) => node?.closest('.ant-select-dropdown,.el-select-dropdown,.ant-cascader-dropdown,.el-cascader__dropdown') || node?.closest(menuSelectorFor(entry)) || node).filter(visible))];
      if (matches.length > 1) throw problem("MENU_AMBIGUOUS", "字段关联了多个菜单，请手动核对");
      if (matches[0]) return matches[0];
    }
    const menus = all(menuSelectorFor(entry)).filter(visible);
    const roots = menus.filter((candidate) => !menus.some((other) => other !== candidate && other.contains(candidate)));
    if (roots.length > 1) throw problem("MENU_AMBIGUOUS", "存在多个菜单，无法确定目标");
    return roots[0] || null;
  }
  function menuOptions(entry, menu) {
    const candidates = all('[role="option"], .list-item-container, .sd-Menu-content-item, [class*="sd-Menu-content-item"], .phoenix-select-dropdown__item, .phoenix-select__option, .ant-select-dropdown-menu-item, .ant-select-item-option, .el-select-dropdown__item, .el-cascader-node, li', menu).filter(visible);
    const nodes = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)));
    entry.optionIds ||= new Map();
    const occurrences = new Map();
    return nodes.map((el) => {
      const text = clean(el.textContent);
      const value = el.getAttribute("data-value") || el.getAttribute("value") || text;
      const key = JSON.stringify([text, value]);
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      const identity = `${key}:${occurrence}`;
      if (!entry.optionIds.has(identity)) entry.optionIds.set(identity, `${request.fieldId}:option${entry.optionIds.size + 1}`);
      return { el, id: entry.optionIds.get(identity), text, value, disabled: el.getAttribute("aria-disabled") === "true" || el.matches('[disabled], .is-disabled, .disabled, .ant-select-item-option-disabled, .ant-select-dropdown-menu-item-disabled, .ant-cascader-menu-item-disabled') || placeholder(text) };
    });
  }
  async function openMenu(entry, scope) {
    scope.opening = true;
    let menu = currentMenu(entry);
    // An unlinked popup already on screen cannot safely be attributed to this field.
    const linked = entry.el.hasAttribute("aria-controls") || entry.el.querySelector("[aria-controls]");
    if (menu && !linked && entry.el.getAttribute("aria-expanded") !== "true") throw problem("MENU_AMBIGUOUS", "已有未关联的菜单打开，请先关闭后重试");
    const wasOpen = Boolean(menu);
    for (let attempt = 0; !menu && attempt < 2; attempt++) {
      scope.guard();
      const expanded = entry.el.getAttribute("aria-expanded") || entry.el.querySelector("[aria-expanded]")?.getAttribute("aria-expanded");
      if (attempt === 0 || expanded === "false") scope.act(() => activate(entry.el.querySelector('.ant-select-selector,.ant-select-selection') || (["date", "cascader"].includes(entry.kind) || entry.el.matches(".el-select") ? entry.el.querySelector('input:not([type="hidden"])') : null) || entry.el));
      menu = await until(() => currentMenu(entry), { timeout: 2200, guard: scope.guard });
      scope.retries = attempt;
    }
    if (!menu) throw problem("MENU_TIMEOUT", "菜单未能展开，请稍后重试", true);
    scope.menu = menu;
    scope.wasOpen = wasOpen;
    return menu;
  }
  async function stableOptions(entry, scope) {
    let options = [];
    const settled = await until(() => {
      const menu = currentMenu(entry);
      if (!menu) return null;
      scope.menu = menu;
      if (menu.matches('[aria-busy="true"], [data-loading="true"]') || menu.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"], .is-loading')) { scope.sawLoading = true; return null; }
      options = menuOptions(entry, menu);
      if (scope.searchPending && !scope.sawLoading && JSON.stringify(semanticOptions(options)) === scope.beforeSearchOptions) return null;
      return options.length ? JSON.stringify(options.map(({ el, ...option }) => option)) : null;
    }, { timeout: 3000, stableFor: 300, guard: scope.guard });
    if (!settled) throw problem("OPTIONS_TIMEOUT", "选项尚未加载完成或需要先输入搜索词", true);
    return options;
  }
  async function searchMenu(entry, scope, query) {
    if (!query) return;
    const search = scope.menu.querySelector('.phoenix-search input:not([type="password"]), input[type="search"], input[role="searchbox"]:not([type="password"])') || (entry.el.matches('input[aria-autocomplete]:not([type="password"])') ? entry.el : entry.el.querySelector('input[aria-autocomplete]:not([type="password"]),.el-input__inner:not([readonly]),.ant-cascader-input:not([readonly]),.ant-select-search__field:not([readonly])'));
    if (!search || search.disabled || search.readOnly) throw problem("SEARCH_UNSUPPORTED", "此控件没有可安全操作的搜索框");
    if (search.value && search.value !== query) throw problem("USER_EDITED", "搜索框已有内容，已保留");
    scope.guard();
    scope.queryInput = search;
    scope.originalQuery = search.value;
    scope.queryValue = query;
    if (search.value !== query) {
      scope.beforeSearchOptions = JSON.stringify(semanticOptions(menuOptions(entry, scope.menu)));
      scope.searchPending = true;
      scope.sawLoading = false;
      entry.activeSearch = { el: search, query, baseline: read(entry) };
      scope.act(() => { search.focus({ preventScroll: true }); setInputText(search, query); });
    }
  }
  async function restoreMenu(entry, scope) {
    if (scope.userEdited) return false;
    if (!scope.committed && scope.queryInput?.isConnected && scope.originalQuery !== undefined && scope.queryInput.value === scope.queryValue && scope.originalQuery !== scope.queryValue) {
      setValue(scope.queryInput, scope.originalQuery);
      scope.queryValue = scope.originalQuery;
      delete entry.activeSearch;
    }
    if (scope.wasOpen || !scope.menu?.isConnected || !visible(scope.menu)) return true;
    // Only use standard dismissal gestures: never select an option or alter page attributes.
    const target = scope.queryInput?.isConnected ? scope.queryInput : entry.el.querySelector("input") || entry.el;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, composed: true }));
    if (await until(() => !visible(scope.menu), { timeout: 240 })) return true;
    const expanded = entry.el.getAttribute("aria-expanded") || entry.el.querySelector("[aria-expanded]")?.getAttribute("aria-expanded");
    if (expanded === "true") {
      entry.el.click();
      if (await until(() => !visible(scope.menu), { timeout: 400 })) return true;
    }
    if (typeof target.blur === "function") target.blur();
    // Framework popup components close on an outside mousedown. The document
    // body cannot submit a form or select another control.
    scope.act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    return Boolean(await until(() => !visible(scope.menu), { timeout: 240 }));
  }
  function activate(el) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    el.focus?.({ preventScroll: true });
    el.click();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  }
  function setInputText(el, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  function enter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  async function mutate(entry, scope, action) {
    scope.guard();
    scope.act(action);
    await wait(60);
    scope.guardStructure();
    scope.expected = read(entry);
  }
  async function clearWidget(entry, scope) {
    scope.guard();
    scope.act(() => {
      for (const target of [entry.el, ...entry.el.querySelectorAll('.el-input')]) {
        target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      }
    });
    await wait(40);
    scope.guard();
    const clearButton = entry.el.querySelector('.ant-select-clear,.ant-select-selection__clear,.ant-cascader-picker-clear,.ant-picker-clear,.ant-calendar-picker-clear,.el-icon-circle-close,.el-select__caret.is-show-close,[aria-label="clear"],[aria-label="Clear"]');
    if (!clearButton) throw problem("UNDO_UNSUPPORTED", "网页没有提供清空按钮，请手动撤销");
    scope.act(() => activate(clearButton));
    const cleared = await until(() => read(entry) === "", { timeout: 1600, guard: scope.guardStructure });
    if (!cleared) throw problem("VALUE_NOT_RETAINED", "网站未清空此字段，请手动撤销");
    scope.expected = ""; scope.committed = true;
  }
  async function chooseCalendarDate(entry, value, scope) {
    const parts = dateParts(value);
    if (!parts) throw problem("DATE_INVALID", "日期不存在或格式不正确");
    const panel = () => currentMenu(entry) || scope.menu;
    const firstVisible = (selector) => [...panel().querySelectorAll(selector)].find(visible);
    const press = async (node) => {
      if (!node || !visible(node)) throw problem("DATE_UNSUPPORTED", "未找到日期面板中的目标，请手动核对");
      await mutate(entry, scope, () => node.click());
      scope.menu = currentMenu(entry) || scope.menu;
    };
    const yearButton = firstVisible('.ant-calendar-year-select,.ant-calendar-month-panel-year-select,.ant-picker-year-btn,.el-date-picker__header-label');
    if (!yearButton) throw problem("DATE_UNSUPPORTED", "此日期面板无法安全选择年份");
    await press(yearButton);
    const yearSelector = '.ant-calendar-year-panel-year,.ant-picker-year-panel .ant-picker-cell-inner,.year-table .cell';
    for (let attempts = 0; attempts < 30; attempts++) {
      const cells = [...panel().querySelectorAll(yearSelector)].filter(visible).filter((node) => /^\d{4}$/.test(clean(node.textContent)) && !node.closest('.disabled,.is-disabled,.ant-picker-cell-disabled'));
      const target = cells.find((node) => Number(clean(node.textContent)) === parts.year);
      if (target) { await press(target); break; }
      if (!cells.length || attempts === 29) throw problem("DATE_UNSUPPORTED", "年份超出日期面板可选择范围");
      const previous = parts.year < Number(clean(cells[0].textContent));
      await press(firstVisible(previous
        ? '.ant-calendar-year-panel-prev-decade-btn,.ant-picker-header-super-prev-btn,.el-date-picker__prev-btn.el-icon-d-arrow-left'
        : '.ant-calendar-year-panel-next-decade-btn,.ant-picker-header-super-next-btn,.el-date-picker__next-btn.el-icon-d-arrow-right'));
    }
    const monthSelector = '.ant-calendar-month-panel-month,.ant-picker-month-panel .ant-picker-cell-inner,.month-table .cell';
    let months = [...panel().querySelectorAll(monthSelector)].filter(visible);
    if (!months.length) {
      const monthButton = firstVisible('.ant-calendar-month-select,.ant-picker-month-btn') || [...panel().querySelectorAll('.el-date-picker__header-label')].filter(visible)[1];
      await press(monthButton);
      months = [...panel().querySelectorAll(monthSelector)].filter(visible);
    }
    if (months.length !== 12) throw problem("DATE_UNSUPPORTED", "日期面板的月份无法唯一识别");
    await press(months[parts.month - 1]);
    if (!/d/i.test(dateFormat(entry))) return;
    const menu = panel();
    const cells = [...menu.querySelectorAll('.ant-calendar-date,.ant-picker-date-panel .ant-picker-cell-inner,.el-date-table td.available span')].filter(visible);
    const candidates = cells.filter((node) => {
      const cell = node.closest("td") || node;
      return Number(clean(node.textContent)) === parts.day && !cell.matches('.disabled,.is-disabled,.ant-picker-cell-disabled,.prev-month,.next-month,.ant-calendar-last-month-cell,.ant-calendar-next-month-btn-day')
        && (!cell.classList.contains("ant-picker-cell") || cell.classList.contains("ant-picker-cell-in-view"));
    });
    // Range popups can show two months. Use the titled date when available.
    const titled = candidates.filter((node) => {
      const title = node.closest("td")?.getAttribute("title") || node.getAttribute("title") || "";
      const parsed = dateParts(title);
      return parsed && parsed.year === parts.year && parsed.month === parts.month && parsed.day === parts.day;
    });
    await press(titled[0] || candidates[0]);
  }
  async function writeDate(entry, value, undo, scope) {
    const inputs = dateInputs(entry);
    if (undo && !value) {
      if (entry.adapter === "my97-date" || entry.adapter === "native-date") {
        await mutate(entry, scope, () => inputs.forEach((input) => setValue(input, "")));
        scope.committed = true; return;
      }
      await clearWidget(entry, scope); return;
    }
    const values = parseValues(value);
    if (values.length !== inputs.length) throw problem("DATE_INVALID", "日期范围需要开始和结束两个日期");
    const formatted = values.map((item) => formatDate(item, dateFormat(entry)));
    if (entry.adapter === "my97-date" || entry.adapter === "native-date") {
      await mutate(entry, scope, () => inputs.forEach((input, index) => setValue(input, formatted[index])));
      scope.committed = true; return;
    }
    if (inputs.every((input) => !input.readOnly)) {
      for (let index = 0; index < inputs.length; index++) {
        await mutate(entry, scope, () => { inputs[index].focus(); setValue(inputs[index], formatted[index]); enter(inputs[index]); inputs[index].blur(); });
      }
      scope.menu = currentMenu(entry);
      scope.committed = true; return;
    }
    await openMenu(entry, scope);
    const panelInputs = [...scope.menu.querySelectorAll('.ant-calendar-input,input.el-input__inner')].filter((input) => visible(input) && !input.readOnly && !input.disabled);
    if (formatted.length === 1 && panelInputs.length && /d/i.test(dateFormat(entry))) {
      for (let index = 0; index < formatted.length; index++) {
        await mutate(entry, scope, () => { panelInputs[index].focus(); setValue(panelInputs[index], formatted[index]); enter(panelInputs[index]); });
      }
    } else {
      for (const item of formatted) await chooseCalendarDate(entry, item, scope);
    }
    const confirm = [...(currentMenu(entry) || scope.menu).querySelectorAll('button,.ant-calendar-ok-btn')].find((node) => visible(node) && !node.disabled && /^(确定|确认|OK|Confirm)$/i.test(clean(node.textContent)));
    if (confirm) await mutate(entry, scope, () => confirm.click());
    scope.committed = true;
  }
  async function writeCascader(entry, value, undo, scope) {
    if (undo && !value) { await clearWidget(entry, scope); return; }
    const values = parseValues(value);
    if (!values.length || values.some((item) => !item.trim())) throw problem("ANSWER_INVALID", "请选择完整的级联路径");
    await openMenu(entry, scope);
    for (let index = 0; index < values.length; index++) {
      let column;
      const ready = await until(() => {
        const menu = currentMenu(entry);
        if (!menu) return false;
        scope.menu = menu;
        column = [...menu.querySelectorAll('.ant-cascader-menu,.el-cascader-menu')].filter(visible)[index];
        return column && menuOptions(entry, column).length ? column : null;
      }, { timeout: 2200, stableFor: 120, guard: scope.guard });
      if (!ready) throw problem("OPTIONS_TIMEOUT", "级联的下一级选项未能展开，请核对", true);
      const selected = exactOption(menuOptions(entry, column), values[index], { location: true });
      await mutate(entry, scope, () => selected.el.click());
    }
    scope.committed = true;
  }
  async function writeChoice(entry, value, undo, scope) {
    const values = entry.multiple ? parseValues(value) : value ? [value] : [];
    const desired = new Set(values.map((item) => exactOption(optionsFor(entry), item).id));
    for (const member of entry.members) {
      if (choiceSelected(member) !== desired.has(idFor(member))) {
        // A selected custom radio may be toggleable; verify will reject a site
        // that does not provide a way to clear it without touching attributes.
        if (entry.multiple || desired.has(idFor(member)) || (undo && !values.length)) await mutate(entry, scope, () => member.click());
      }
    }
    scope.committed = true;
  }
  async function write(entry, value, undo = false, scope) {
    if (entry.kind === "date") return writeDate(entry, value, undo, scope);
    if (entry.kind === "cascader") return writeCascader(entry, value, undo, scope);
    if (entry.kind === "choice") return writeChoice(entry, value, undo, scope);
    if (entry.kind === "custom-select") {
      if (undo && !value) return clearWidget(entry, scope);
      await openMenu(entry, scope);
      await searchMenu(entry, scope, entry.optionsQuery || request.query || "");
      const options = await stableOptions(entry, scope);
      if (!undo && entry.inspectedOptions && JSON.stringify(semanticOptions(options)) !== JSON.stringify(semanticOptions(entry.inspectedOptions))) throw problem("OPTIONS_CHANGED", "候选选项已变化，请重新核对答案");
      const part = descriptor(entry).datePart;
      const dateValue = (text) => Number(clean(text).replace(/年|月|日/g, ""));
      const partMatches = part && /^\d+$/.test(value) ? options.filter((op) => !op.disabled && /^\d+[年月日]?$/.test(op.text) && dateValue(op.text) === Number(value)) : [];
      const selected = partMatches.length === 1 ? partMatches[0] : exactOption(options, value);
      if (request.optionId && selected.id !== request.optionId) throw problem("OPTIONS_CHANGED", "确认的选项与当前候选不一致，请重新核对");
      scope.guard();
      if (!selected.el.isConnected || !visible(selected.el)) throw problem("OPTIONS_CHANGED", "选项刚刚发生变化，请重新核对");
      scope.act(() => selected.el.click());
      scope.committed = true;
      delete entry.activeSearch;
      const confirm = [...scope.menu.querySelectorAll("button")].find((b) => visible(b) && !b.disabled && /^(确定|确认|OK|Confirm)$/i.test(clean(b.textContent)));
      if (confirm) scope.act(() => confirm.click());
      return;
    }
    scope.guard();
    const options = optionsFor(entry);
    if (entry.kind === "select" && !entry.el.multiple) {
      if (undo && !value) setValue(entry.el, "");
      else setValue(entry.el, exactOption(options, value).value);
    } else if (["checkboxes", "radio"].includes(entry.kind) || entry.el.multiple) {
      if (undo && !value && entry.kind === "radio" && entry.el.closest('.ant-radio-group,.el-radio-group')) throw problem("UNDO_UNSUPPORTED", "网页单选组没有取消入口，请手动修改");
      const values = entry.kind === "radio" ? (value ? [value] : []) : value ? JSON.parse(value) : [];
      if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) throw new Error("请按选项选择答案");
      const ids = new Set(values.map((v) => exactOption(options, v).id));
      for (const node of entry.members || [...entry.el.options]) {
        const key = entry.el.multiple ? "selected" : "checked";
        const chosen = ids.has(idFor(node));
        if (node[key] === chosen) continue;
        if (key === "checked" && (chosen || node.type === "checkbox")) await mutate(entry, scope, () => node.click());
        else await mutate(entry, scope, () => {
          node[key] = chosen;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      if (entry.el.multiple) entry.el.dispatchEvent(new Event("change", { bubbles: true }));
    } else setValue(entry.el, value);
  }
  async function verify(entry, expected, undo = false, scope) {
    let observed = false;
    const verified = await until(() => {
      const datePart = descriptor(entry).datePart;
      const actual = read(entry);
      const sameDatePart = datePart && /^\d+[年月日]?$/.test(actual) && /^\d+[年月日]?$/.test(expected) && Number(actual.replace(/[年月日]/g, "")) === Number(expected.replace(/[年月日]/g, ""));
      const sameChoice = ["select", "radio", "checkboxes", "choice", "custom-select"].includes(entry.kind) && !!actual && !!expected && (() => {
        const left = parseValues(actual), right = parseValues(expected);
        return left.length === right.length && right.every((value) => optionMatch(left, value));
      })();
      const samePath = entry.kind === "cascader" && !!actual && !!expected && (() => {
        const left = actual.startsWith("[") ? parseValues(actual) : actual.split(/\s*[\/＞>›]\s*/).filter(Boolean);
        const right = parseValues(expected);
        return left.length === right.length && left.every((value, index) => optionMatch([value], right[index], { location: true }));
      })();
      if (actual !== expected && !sameDatePart && !(entry.kind === "date" && sameDate(actual, expected, entry)) && !sameChoice && !samePath) {
        if (observed) throw problem("VALUE_NOT_RETAINED", "网站未保留填写值，请核对");
        return null;
      }
      observed = true;
      const error = validation(entry);
      if (error && !undo) throw problem("VALIDATION_FAILED", error);
      return "retained";
    }, { timeout: 2600, stableFor: 700, guard: () => {
      assertTarget();
      if (scope.userEdited) throw problem("USER_EDITED", "核验期间检测到手动输入，已保留网页内容");
      resolve(true, expected);
    } });
    return verified ? { status: "verified", code: "VERIFIED", retryable: false, reason: "已在稳定窗口内回读核验" } : fail("网站未保留填写值，请核对", "failed", "VALUE_NOT_RETAINED");
  }
  if (request.action === "scan") {
    if (state.busy) throw new Error("正在填写，请稍后重新识别");
    state.visualWatch?.release();
    state.scanId = crypto.randomUUID();
    state.nodes.clear();
    const fields = discover().map((entry, order) => {
      entry.order = order;
      const field = descriptor(entry);
      entry.baseline = field.value;
      entry.datePart = field.datePart;
      entry.signature = signature(field);
      entry.snapshot = field;
      state.nodes.set(field.fieldId, entry);
      return field;
    });
    const headings = all("h1, h2, h3").filter(visible).map((el) => clean(el.textContent)).filter(Boolean).slice(0, 30);
    const title = document.title;
    const hasApplication = fields.some((f) => /学校|学历|简历|申请|教育|经历|university|education|resume|application|experience/i.test(f.contextPath));
    const login = !hasApplication && fields.some((f) => f.type === "password" || /验证码|captcha/i.test(f.label));
    const jobText = all('[class*="job-description"], [class*="jobDescription"], [data-job-description]').filter(visible).filter((el) => !el.querySelector('input, textarea, select, [contenteditable="true"]')).map((el) => clean(el.textContent)).join("\n").slice(0, 5000);
    return { token: state.token, scanId: state.scanId, url: location.href, title, headings, fields, jobText, pageType: login ? "login" : hasApplication ? "application" : fields.filter((f) => f.supported && !/search|搜索/i.test(f.label)).length > 1 ? "form" : jobText ? "job" : "unknown", iframeCount: all("iframe").length };
  }
  if (request.action === "ping") return { token: state.token, scanId: state.scanId, url: location.href };
  if (request.action === "visual-layout") {
    assertTarget();
    if (request.releaseWatch) {
      if (state.visualWatch?.id === request.releaseWatch) state.visualWatch.release();
      return { released: true };
    }
    if (request.watchId && state.visualWatch?.id !== request.watchId) throw problem("VISUAL_CHANGED", "截图布局观察已过期，请重新识别");
    if (state.busy) throw problem("VISUAL_BUSY", "页面正在填写或读取选项，请稍后再做截图识别");
    if (window !== window.top) throw problem("VISUAL_FRAME", "截图识别只支持当前主页面");
    const viewport = { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, devicePixelRatio: window.devicePixelRatio || 1, visualScale: window.visualViewport?.scale || 1, visualOffsetX: window.visualViewport?.offsetLeft || 0, visualOffsetY: window.visualViewport?.offsetTop || 0 };
    const clip = (rect) => {
      const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
      const right = Math.min(viewport.width, rect.right), bottom = Math.min(viewport.height, rect.bottom);
      return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
    };
    const rectangles = (node) => visible(node) ? [...node.getClientRects()].map(clip).filter(Boolean) : [];
    const redactions = [];
    const watchedNodes = new Set();
    const mask = (node) => { if (node) watchedNodes.add(node); redactions.push(...rectangles(node)); };
    // Geometry only: no control values, text, selectors, names or DOM fragments
    // leave this action. These rectangles are applied to a detached canvas.
    for (const node of all('input, textarea, select, button, output, [role="textbox"], [role="combobox"], [role="listbox"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"], [role="spinbutton"], [contenteditable]:not([contenteditable="false"]), iframe, frame, embed, object, [data-answer], [data-field-value], [class*="selected-value"], .ant-select-selection-item, .phoenix-select__value, .sd-Select-value')) mask(node);
    const fields = [];
    for (const [localFieldId, entry] of state.nodes) {
      if (!entry.el.isConnected || !visible(entry.el)) continue;
      const field = descriptor(entry);
      if (field.value || ["password", "file"].includes(field.type)) mask(containerFor(entry.el));
      if (!field.supported || field.value) continue;
      if (signature(field) !== entry.signature) throw problem("VISUAL_CHANGED", "页面问题或选项已变化，请更新问题后再截图");
      const nodes = entry.members?.length ? entry.members : [entry.el];
      nodes.forEach((node) => watchedNodes.add(node));
      const rects = nodes.flatMap(rectangles);
      if (!rects.length) continue;
      const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
      const rect = { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
      const center = document.elementFromPoint(Math.min(viewport.width - 1, rect.x + rect.width / 2), Math.min(viewport.height - 1, rect.y + rect.height / 2));
      const onTop = nodes.some((node) => node === center || node.contains(center) || center === node.getRootNode()?.host);
      // A modal, opaque frame, or overlay covering the field is not a visible candidate.
      if (onTop && fields.length < 30) fields.push({ localFieldId, rect });
    }
    if (redactions.length > 5000) throw problem("VISUAL_TOO_LARGE", "当前页面内容过多，无法完整遮盖，请继续使用网页文字识别");
    const unique = [...new Map(redactions.map((rect) => [JSON.stringify(rect), rect])).values()];
    if (request.startWatch) {
      if (state.visualWatch) throw problem("VISUAL_BUSY", "此页面已有截图识别，请稍后重试");
      if (typeof request.startWatch !== "string" || request.startWatch.length > 80) throw problem("VISUAL_CHANGED", "无效的截图观察标识");
      const watch = { id: request.startWatch, changed: false };
      let frame;
      let timeout;
      const invalidate = () => { watch.changed = true; };
      const geometry = () => JSON.stringify([innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio, visualViewport?.scale, visualViewport?.offsetLeft, visualViewport?.offsetTop, [...watchedNodes].map((node) => node.isConnected ? [...node.getClientRects()].map((r) => [r.x, r.y, r.width, r.height]) : null)]);
      const initial = geometry();
      const observeFrame = () => { if (geometry() !== initial) invalidate(); frame = requestAnimationFrame(observeFrame); };
      const observer = new MutationObserver(invalidate);
      // Labels can change through aria-label, placeholder, name, or framework
      // attributes without moving a control. Observe every attribute so even a
      // transient change cannot be mistaken for the original question.
      const options = { subtree: true, childList: true, characterData: true, attributes: true };
      observer.observe(document.documentElement, options);
      for (const host of all("*")) if (host.shadowRoot) observer.observe(host.shadowRoot, options);
      for (const name of ["scroll", "resize", "input", "change"]) window.addEventListener(name, invalidate, true);
      window.visualViewport?.addEventListener("resize", invalidate);
      window.visualViewport?.addEventListener("scroll", invalidate);
      watch.release = () => {
        cancelAnimationFrame(frame); clearTimeout(timeout); observer.disconnect();
        for (const name of ["scroll", "resize", "input", "change"]) window.removeEventListener(name, invalidate, true);
        window.visualViewport?.removeEventListener("resize", invalidate);
        window.visualViewport?.removeEventListener("scroll", invalidate);
        if (state.visualWatch === watch) state.visualWatch = null;
      };
      state.visualWatch = watch;
      frame = requestAnimationFrame(observeFrame);
      // Abandoned captures must not leave observers running after cancellation,
      // extension reload, or a lost message response.
      timeout = setTimeout(watch.release, 5000);
    }
    return { viewport, fields, redactions: unique, ...(state.visualWatch ? { watchId: state.visualWatch.id, changed: state.visualWatch.changed } : {}) };
  }
  if (request.action === "changes") {
    assertTarget();
    const currentEntries = discover();
    return {
      added: currentEntries.filter((entry) => !state.nodes.has(idFor(entry.el))).length,
      changed: [...state.nodes.entries()].filter(([, entry]) => !entry.el.isConnected || signature(descriptor(entry)) !== entry.signature || !visible(entry.el)).map(([id]) => id)
    };
  }
  if (request.action === "operation-result") {
    assertTarget();
    return state.operations.get(request.operationId) || { status: "unknown", reason: "上次操作未能确认，请在网页核对后重新识别" };
  }
  if (request.action === "locate") {
    const entry = resolve(false);
    entry.el.scrollIntoView({ block: "center", behavior: "smooth" });
    entry.el.animate([{ outline: "3px solid #167c68" }, { outline: "3px solid transparent" }], { duration: 1800 });
    return { status: "located" };
  }
  if (request.action === "inspect-options") {
    assertTarget();
    if (state.busy) return fail("此页面已有操作正在进行", "skipped", "BUSY", true);
    state.busy = true;
    let entry;
    let scope;
    let result;
    let restored = false;
    const focused = document.activeElement;
    try {
      entry = resolve();
      if (!["custom-select", "cascader"].includes(entry.kind)) return { status: "inspected", field: descriptor(entry), options: optionsFor(entry), restored: true };
      scope = transaction(entry, read(entry));
      await openMenu(entry, scope);
      if (request.query !== undefined && (typeof request.query !== "string" || request.query.length > 200 || /密码|验证码|password|captcha/i.test(entry.snapshot.label))) throw problem("UNSAFE_QUERY", "无法安全使用此搜索词");
      await searchMenu(entry, scope, request.query || "");
      const options = (await stableOptions(entry, scope)).map(({ el, ...option }) => option);
      scope.guard();
      restored = await restoreMenu(entry, scope);
      if (!restored) throw problem("MENU_RESTORE_FAILED", "已读取候选，但菜单无法安全恢复，请在网页关闭菜单后重新识别");
      scope.guard();
      entry.inspectedOptions = options;
      entry.optionsQuery = request.query || "";
      const field = descriptor(entry);
      entry.snapshot = field;
      entry.signature = signature(field);
      result = { status: "inspected", code: "OPTIONS_INSPECTED", retryable: false, field, options, query: entry.optionsQuery, restored: true, rebound: !!entry.rebound };
    } catch (error) {
      result = fail(error.message, error.code === "USER_EDITED" ? "skipped" : "failed", error.code, !!error.retryable);
    } finally {
      if (scope) {
        if (!restored) restored = await restoreMenu(entry, scope);
        scope.release();
        if (!scope.userEdited && focused?.isConnected && focused !== document.body) focused.focus({ preventScroll: true });
      }
      state.busy = false;
    }
    return { ...result, restored };
  }
  if (request.action === "fill" || request.action === "undo") {
    assertTarget();
    if (state.operations.has(request.operationId)) return state.operations.get(request.operationId);
    if (state.busy) return fail("此页面已有填写操作正在进行", "skipped", "BUSY", true);
    state.busy = true;
    let result;
    let entry;
    let before;
    let scope;
    try {
      entry = resolve(true, request.action === "undo" ? request.expected : undefined);
      before = read(entry);
      const undo = request.action === "undo";
      if (before !== (undo ? request.expected : entry.baseline) || (!undo && before !== "")) result = fail("网页已有内容或已被修改，保留原值", "skipped", "USER_EDITED");
      else {
        if (typeof request.value !== "string" || (!undo && !request.value.trim())) throw problem("ANSWER_INVALID", "答案为空或格式不正确");
        const maxLength = descriptor(entry).constraints.maxLength;
        if (maxLength && request.value.length > maxLength) throw problem("ANSWER_TOO_LONG", "答案超过网页字数限制");
        scope = transaction(entry, before);
        await write(entry, request.value, undo, scope);
        result = { ...await verify(entry, request.value, undo, scope), before, after: read(entry), rebound: !!entry.rebound, retries: scope.retries || 0 };
      }
    } catch (error) {
      result = { ...fail(error.message, error.code === "USER_EDITED" ? "skipped" : "failed", error.code, !!error.retryable), ...(entry ? { before, after: descriptor(entry).value, rebound: !!entry.rebound } : {}) };
    } finally {
      if (scope) { await restoreMenu(entry, scope); scope.release(); }
      state.busy = false;
    }
    state.operations.set(request.operationId, result);
    if (state.operations.size > 500) state.operations.delete(state.operations.keys().next().value);
    return result;
  }
  throw new Error("不支持的申请助手操作");
}
