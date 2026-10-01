// Runs the 2025 answers through CIP-179 and back:
// SurveyJS row → CIP-179 response → label-17 metadata → CBOR-sized detailed
// JSON → decoded response → SurveyJS row, which must equal the original.
//
//   node --test cip179/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { decodeMetadata, describeProblems, encodeMetadata, validateResponse } from "cip-179";

import { answersToRow, rowToAnswers, withoutHiddenAnswers } from "../answers.js";
import { buildSurvey } from "../definition.js";
import { fromDetailedJson, toCbor, toDetailedJson } from "../metadatum.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const survey = read("../../../2025/data/survey.json");
// One 2025 row has "Iteam 15" for question31's "Item 15".
const rows = read("../../../2025/data/answers.json").map((row) =>
  row.question31?.includes("Iteam 15")
    ? { ...row, question31: row.question31.map((v) => (v === "Iteam 15" ? "Item 15" : v)) }
    : row,
);

const built = buildSurvey(survey, {
  owner: { type: "key", keyHash: new Uint8Array(28) },
  endEpoch: 600,
  freeTextSchema: { uri: "https://example.org/free-text.schema.json", hash: new Uint8Array(32) },
});
const { definition, conditions, mapping } = built;

test("the 2025 survey's problems are the known ones", () => {
  const errors = built.problems.filter((p) => p.level === "error").map((p) => `${p.question}: ${p.message}`);
  assert.deepEqual(errors, [
    // `notcontains 'Item 10'`, but question13 has no "Item 10": in 2025 the
    // two questions were always shown.
    'question14: visibleIf: question13 has no option "Item 10"; the condition is left out',
    'question15: visibleIf: question13 has no option "Item 10"; the condition is left out',
    ...[
      ["question6", "Employed by/contracting with a genesis entity (IO[HK,E,G], EMURGO, CF)"],
      ["question8", "I have worked in other blockchain ecosystems before but moved to Cardano"],
      ["question8", "Besides Cardano I also work in parallel with other blockchain ecosystems"],
      ["question7", "Ethereum L2s (Polygon; Starknet; Arbitrum; Optimism; Scroll; Aztec; etc)"],
      ["question12", "Additional core primitives e.g. zero-knowledge, new virtual machine"],
      ["question31", "Cardano Blueprint (https://cardano-scaling.github.io/cardano-blueprint/)"],
    ].map(([q, label]) => `${q}: option label is over 64 bytes: "${label}"`),
  ]);
});

test("the non-developer answer is screened out of the definition", () => {
  assert.deepEqual([...built.screening], [["question2", new Set(["Item 5"])]]);
  const q2 = mapping.questions.findIndex((m) => m.name === "question2");
  assert.ok(!mapping.questions[q2].values.includes("Item 5"));
});

test("every 2025 answer row survives the round trip", () => {
  const unknown = [];
  rows.forEach((original, i) => {
    const { answers, problems } = rowToAnswers(original, definition, mapping);
    unknown.push(...problems);

    const response = {
      specVersion: definition.specVersion,
      surveyRef: { txId: new Uint8Array(32), index: 0 },
      role: 4,
      credential: { type: "key", keyHash: new Uint8Array(28).fill(i) },
      answers: { type: "public", answers },
    };
    assert.deepEqual(describeProblems(validateResponse(definition, response)), [], `row ${i}`);

    const metadata = encodeMetadata({ type: "responses", responses: [response] });
    assert.ok(toCbor(metadata).length < 16384);
    const stored = JSON.parse(JSON.stringify(toDetailedJson(metadata)));
    const [decoded] = decodeMetadata(fromDetailedJson(stored)).responses;

    const visible = withoutHiddenAnswers(definition, conditions, decoded.answers.answers);
    const { row, problems: back } = answersToRow(visible.answers, mapping);
    assert.deepEqual(back, []);
    assert.deepEqual(row, comparable(original), `row ${i}`);
  });
  assert.deepEqual(unknown, []);
});

/** The row without what the round trip can't keep. */
function comparable(row) {
  const { pageNo, ...answers } = row; // SurveyJS's saved page, not an answer
  for (const [name, value] of Object.entries(answers)) {
    if (value === "") delete answers[name];
  }
  return answers;
}
