// How SurveyJS ratings map to CIP-179, whose rating questions rate at least
// 2 items: a matrix is a rating question, a single rating is a single choice
// (named levels) or a numeric range.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeMetadata, describeProblems, encodeMetadata, validateResponse } from "cip-179";

import { answersToRow, rowToAnswers } from "../answers.js";
import { buildSurvey } from "../definition.js";

const build = (elements) =>
  buildSurvey(
    { title: "Ratings", pages: [{ name: "p", elements }] },
    {
      owner: { type: "key", keyHash: new Uint8Array(28) },
      endEpoch: 600,
      freeTextSchema: { uri: "https://example.org/free-text.schema.json", hash: new Uint8Array(32) },
    },
  );

const matrix = {
  type: "matrix",
  name: "tools",
  title: "How satisfied are you with these tools?",
  isRequired: true,
  rows: [
    { value: "docs", text: { default: "Documentation", ja: "ドキュメント" } },
    { value: "libs", text: "Libraries" },
  ],
  columns: [
    { value: "bad", text: { default: "Bad", ja: "悪い" } },
    { value: "ok", text: { default: "OK", ja: "普通" } },
    { value: "good", text: { default: "Good", ja: "良い" } },
  ],
};

test("a matrix is a rating question with a labelled scale", () => {
  const { definition, mapping, translations, problems } = build([matrix]);
  assert.deepEqual(problems, []);
  assert.deepEqual(definition.questions, [
    {
      type: "rating",
      prompt: "How satisfied are you with these tools?",
      options: { type: "options", labels: ["Documentation", "Libraries"] },
      scale: { type: "labels", labels: ["Bad", "OK", "Good"] },
      requireAll: false,
      required: true,
    },
  ]);
  assert.deepEqual(mapping.questions, [{ name: "tools", values: ["docs", "libs"], levels: ["bad", "ok", "good"] }]);
  assert.deepEqual(translations.translations.ja.questions, [
    { options: ["ドキュメント", "Libraries"], ratingLabels: ["悪い", "普通", "良い"] },
  ]);
});

test("matrix answers survive the round trip", () => {
  const { definition, mapping } = build([matrix]);
  const original = { tools: { libs: "good", docs: "bad" } };
  const { answers, problems } = rowToAnswers(original, definition, mapping);
  assert.deepEqual(problems, []);
  const response = {
    specVersion: definition.specVersion,
    surveyRef: { txId: new Uint8Array(32), index: 0 },
    role: 4,
    credential: { type: "key", keyHash: new Uint8Array(28) },
    answers: { type: "public", answers },
  };
  assert.deepEqual(describeProblems(validateResponse(definition, response)), []);
  const [decoded] = decodeMetadata(encodeMetadata({ type: "responses", responses: [response] })).responses;
  assert.deepEqual(answersToRow(decoded.answers.answers, mapping), { row: original, problems: [] });
});

test("a matrix with one row is reported", () => {
  const { problems } = build([{ ...matrix, rows: matrix.rows.slice(0, 1) }]);
  assert.deepEqual(problems.map((p) => p.message), [
    "a matrix needs at least 2 rows on chain; use a rating question for a single item",
    "survey must have at least one question",
  ]);
});

test("a single rating is a single choice or a numeric range", () => {
  const { definition, mapping } = build([
    { type: "rating", name: "named", rateValues: [{ value: 1, text: "Low" }, { value: 2, text: "High" }] },
    { type: "rating", name: "plain", rateMax: 10 },
  ]);
  assert.deepEqual(
    definition.questions.map((q) => q.type),
    ["singleChoice", "numericRange"],
  );
  assert.deepEqual(mapping.questions[0].values, [1, 2]);
  assert.deepEqual(definition.questions[1].constraints, { min: 1n, max: 10n, step: 1n });
});
