import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiSuggestionPayload,
  extractAiSuggestionText,
  trimForAiContext
} from "../src/aiSuggest.js";

test("buildAiSuggestionPayload asks for a direct answer and includes compact context", () => {
  const payload = buildAiSuggestionPayload({
    model: "gpt-5-nano",
    question: "Why do you want to join this company?",
    language: "en",
    profile: {
      englishName: "Kaiwen Luo",
      phone: "+86 18825202614",
      commonAnswers: {
        whyCompany: {
          en: "I am interested in financial technology and structured training."
        }
      },
      internships: [
        {
          company: "ABC",
          role: "Finance Intern",
          description: "Built weekly reporting dashboards."
        }
      ]
    },
    memories: [
      {
        question: "Why this firm?",
        answer: "I value data-driven finance work."
      }
    ]
  });

  assert.equal(payload.model, "gpt-5-nano");
  assert.equal(payload.max_output_tokens, 160);
  assert.match(payload.input[0].content, /only the answer/i);
  assert.match(payload.input[1].content, /Why do you want to join this company/);
  assert.match(payload.input[1].content, /Kaiwen Luo/);
  assert.match(payload.input[1].content, /Finance Intern/);
});

test("extractAiSuggestionText reads Responses API output_text first", () => {
  assert.equal(extractAiSuggestionText({ output_text: "  Hong Kong  " }), "Hong Kong");
});

test("extractAiSuggestionText falls back to nested content text", () => {
  assert.equal(extractAiSuggestionText({
    output: [
      {
        content: [
          { type: "output_text", text: "Master of Accounting" }
        ]
      }
    ]
  }), "Master of Accounting");
});

test("trimForAiContext removes long noisy values", () => {
  const trimmed = trimForAiContext(" a ".repeat(500), 12);
  assert.ok(trimmed.endsWith("..."));
  assert.ok(trimmed.length <= 15);
});
