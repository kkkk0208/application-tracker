export function findPotentialDuplicate(draft, records) {
  const draftId = draft.id || "";
  const draftPortalLink = normalizeUrl(draft.portalLink);
  const draftCompany = normalizeText(draft.company);
  const draftRole = normalizeText(draft.role);

  for (const record of records) {
    if (record.id && record.id === draftId) continue;

    if (draftPortalLink && normalizeUrl(record.portalLink) === draftPortalLink) {
      return { reason: "portalLink", record };
    }

    if (
      draftCompany &&
      draftRole &&
      normalizeText(record.company) === draftCompany &&
      normalizeText(record.role) === draftRole
    ) {
      return { reason: "companyRole", record };
    }
  }

  return null;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}
