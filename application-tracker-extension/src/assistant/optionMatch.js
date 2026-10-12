// Keep this self-contained function identical to the copy inside pageBridge.
export function optionMatch(options, value, { location = false } = {}) {
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
