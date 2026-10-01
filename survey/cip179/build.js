#!/usr/bin/env node
// Builds the CIP-179 survey from `survey.json`, and reports what doesn't fit.
//
//   node cip179/build.js                       # check only
//   node cip179/build.js --owner <key hash> --end-epoch <epoch> --out <dir>
//
// Options:
//   --survey <file>      SurveyJS survey (default: public/survey.json)
//   --owner <hex>        owner key hash (28 bytes), who can cancel the survey
//   --end-epoch <n>      last epoch in which responses count
//   --schema-uri <uri>   where free-text-schema.json is published
//   --out <dir>          write definition.metadata.json, widget.json, mapping.json
//
// Exits with status 1 when there are errors.

import { blake2b } from "@noble/hashes/blake2.js";
import { encodeMetadata } from "cip-179";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildSurvey } from "./definition.js";
import { toCbor, toDetailedJson } from "./metadatum.js";

const SCHEMA_FILE = new URL("./free-text.schema.json", import.meta.url);
const DEFAULT_SCHEMA_URI =
  "https://cardano-foundation.github.io/state-of-the-developer-ecosystem/survey/cip179/free-text.schema.json";

const { values: args } = parseArgs({
  options: {
    survey: { type: "string", default: "public/survey.json" },
    owner: { type: "string" },
    "end-epoch": { type: "string" },
    "schema-uri": { type: "string", default: DEFAULT_SCHEMA_URI },
    out: { type: "string" },
  },
});

if (args.out && (!args.owner || !args["end-epoch"])) {
  console.error("--out needs --owner and --end-epoch");
  process.exit(2);
}

const schemaBytes = readFileSync(SCHEMA_FILE);
const maxTextBytes = JSON.parse(schemaBytes).maxUtf8Bytes;
const survey = JSON.parse(readFileSync(args.survey, "utf8"));
const built = buildSurvey(survey, {
  owner: { type: "key", keyHash: args.owner ? hexBytes(args.owner, 28) : new Uint8Array(28) },
  endEpoch: Number(args["end-epoch"] ?? 0),
  freeTextSchema: { uri: args["schema-uri"], hash: blake2b(schemaBytes, { dkLen: 32 }) },
});
const { definition, conditions, translations, mapping, screening, problems } = built;

// Report
for (const level of ["error", "warning", "info"]) {
  for (const p of problems.filter((p) => p.level === level)) {
    console.log(`${level.padEnd(7)} ${p.question ? `${p.question}: ` : ""}${p.message}`);
  }
}
const hasErrors = problems.some((p) => p.level === "error");
// Over-long labels can't be encoded; cut them to measure the size anyway.
const longLabels = problems.some((p) => p.message.startsWith("option label is over"));
const metadata = encodeMetadata({ type: "definitions", definitions: [longLabels ? cutLabels(definition) : definition] });
const count = (type) => definition.questions.filter((q) => q.type === type).length;
console.log(`
${definition.questions.length} questions (${["singleChoice", "multiSelect", "ranking", "rating", "numericRange", "custom"]
  .map((t) => `${count(t)} ${t}`)
  .join(", ")}), ${Object.keys(conditions).length} conditional
languages: en (on chain), ${Object.keys(translations.translations).join(", ")}
definition metadata: ${toCbor(metadata).length} bytes${longLabels ? ", with long labels cut to 64 bytes" : ""} (a transaction is at most 16384)
longest possible response metadata: ${toCbor(longestResponse(definition, maxTextBytes)).length} bytes, with free text up to ${maxTextBytes} bytes`);

if (args.out && hasErrors) {
  console.error("not written: fix the errors first");
} else if (args.out) {
  mkdirSync(args.out, { recursive: true });
  const write = (file, value) => writeFileSync(join(args.out, file), JSON.stringify(value, null, 2) + "\n");
  write("definition.metadata.json", { 17: toDetailedJson(metadata.get(17n)) });
  write("widget.json", {
    conditions,
    translations,
    maxTextBytes,
    screening: [...screening].map(([name, values]) => ({ name, values: [...values] })),
  });
  write("mapping.json", mapping);
  console.log(`written to ${args.out}`);
}

process.exit(hasErrors ? 1 : 0);

// ----------------------------------------------------------------------------

function hexBytes(hex, length) {
  if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex)) {
    console.error(`expected ${length} bytes in hex, got ${hex}`);
    process.exit(2);
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function cutLabels(definition) {
  const cut = (label) => {
    let text = label;
    while (new TextEncoder().encode(text).length > 64) text = text.slice(0, -1);
    return text;
  };
  const questions = definition.questions.map((q) =>
    q.options ? { ...q, options: { ...q.options, labels: q.options.labels.map(cut) } } : q,
  );
  return { ...definition, questions };
}

/** Label-17 metadata of a response answering everything, as long as allowed. */
function longestResponse(definition, maxTextBytes) {
  const answers = definition.questions.map((q, questionIndex) => {
    const count = q.options?.labels.length;
    const highest = (n) => Array.from({ length: n }, (_, i) => count - 1 - i);
    switch (q.type) {
      case "singleChoice":
        return { type: "singleChoice", questionIndex, optionIndex: count - 1 };
      case "multiSelect":
        return { type: "multiSelect", questionIndex, optionIndices: highest(q.maxSelections) };
      case "ranking":
        return { type: "ranking", questionIndex, ranking: highest(q.maxRanked) };
      case "rating":
        return {
          type: "rating",
          questionIndex,
          ratings: highest(count).map((optionIndex) => ({ optionIndex, rating: BigInt(q.scale.labels.length - 1) })),
        };
      case "numericRange":
        return { type: "numeric", questionIndex, value: q.constraints.max };
      case "custom":
        // 64-byte chunks of 3-byte characters waste one byte each.
        return { type: "custom", questionIndex, value: Array(Math.ceil(maxTextBytes / 63)).fill("あ".repeat(21)) };
    }
  });
  return encodeMetadata({
    type: "responses",
    responses: [
      {
        specVersion: definition.specVersion,
        surveyRef: { txId: new Uint8Array(32), index: 0 },
        role: 4,
        credential: { type: "key", keyHash: new Uint8Array(28) },
        answers: { type: "public", answers },
      },
    ],
  });
}
