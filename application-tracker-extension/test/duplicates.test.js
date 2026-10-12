import test from "node:test";
import assert from "node:assert/strict";
import { findPotentialDuplicate } from "../src/duplicates.js";

test("findPotentialDuplicate detects matching portal link", () => {
  const duplicate = findPotentialDuplicate({
    company: "Other",
    role: "Other",
    portalLink: "https://example.com/job"
  }, [
    {
      id: "1",
      company: "Acme",
      role: "Analyst",
      portalLink: "https://example.com/job"
    }
  ]);

  assert.deepEqual(duplicate, {
    reason: "portalLink",
    record: {
      id: "1",
      company: "Acme",
      role: "Analyst",
      portalLink: "https://example.com/job"
    }
  });
});

test("findPotentialDuplicate detects matching company and role case-insensitively", () => {
  const duplicate = findPotentialDuplicate({
    company: " acme ",
    role: "analyst",
    portalLink: "https://example.com/new"
  }, [
    {
      id: "1",
      company: "Acme",
      role: "Analyst",
      portalLink: "https://example.com/job"
    }
  ]);

  assert.equal(duplicate.reason, "companyRole");
  assert.equal(duplicate.record.id, "1");
});

test("findPotentialDuplicate ignores current edited record", () => {
  const duplicate = findPotentialDuplicate({
    id: "1",
    company: "Acme",
    role: "Analyst",
    portalLink: "https://example.com/job"
  }, [
    {
      id: "1",
      company: "Acme",
      role: "Analyst",
      portalLink: "https://example.com/job"
    }
  ]);

  assert.equal(duplicate, null);
});
