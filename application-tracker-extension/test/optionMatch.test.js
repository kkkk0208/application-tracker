import test from "node:test";
import assert from "node:assert/strict";
import { optionMatch } from "../src/assistant/optionMatch.js";
import { OPTION_MATCH_CASES } from "./fixtures/optionMatchCases.js";
import { pageBridge } from "../src/assistant/pageBridge.js";

for (const fixture of OPTION_MATCH_CASES) {
  test(`optionMatch: ${fixture.name}`, () => {
    const before = JSON.stringify(fixture.options);
    assert.equal(optionMatch(fixture.options, fixture.value, fixture.context), fixture.expectedIndex < 0 ? null : fixture.options[fixture.expectedIndex]);
    assert.equal(JSON.stringify(fixture.options), before);
  });
}

test("optionMatch can be serialized without external variables", () => {
  const copied = Function(`return (${optionMatch.toString()})`)();
  for (const fixture of OPTION_MATCH_CASES) assert.equal(copied(fixture.options, fixture.value, fixture.context), fixture.expectedIndex < 0 ? null : fixture.options[fixture.expectedIndex]);
});

test("pageBridge contains the same option matcher and passes all shared cases", () => {
  const source = pageBridge.toString();
  const start = source.indexOf("function optionMatch(");
  assert.ok(start >= 0, "The injected bridge needs its self-contained matcher");
  const ending = /\n[ \t]*return unique\(matches\);[ \t]*\r?\n[ \t]*}/.exec(source.slice(start));
  assert.ok(ending, "The inline matcher must have its final unique-match return");
  const end = start + ending.index + ending[0].length;
  const inlineSource = source.slice(start, end);
  assert.equal(inlineSource.replace(/\s+/g, ""), optionMatch.toString().replace(/\s+/g, ""));
  const inline = Function(`return (${inlineSource})`)();
  for (const fixture of OPTION_MATCH_CASES) assert.equal(inline(fixture.options, fixture.value, fixture.context), fixture.expectedIndex < 0 ? null : fixture.options[fixture.expectedIndex], fixture.name);
});
