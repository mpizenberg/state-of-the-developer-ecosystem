#!/usr/bin/env node
// Serves a local preview of the CIP-179 survey in the <tessera-respond>
// widget. Nothing is submitted: the page checks the response the widget
// gives and shows it as an `answers.json` row.
//
//   node cip179/preview.js [--survey <file>] [--port <n>]
//
// The survey is rebuilt on every page load, so edits to `survey.json` show
// after a reload. Unlike `build.js`, errors don't stop the preview: they are
// listed on the page, and labels over 64 bytes are cut.

import { blake2b } from "@noble/hashes/blake2.js";
import { encodeMetadata } from "cip-179";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildSurvey, cutLabels } from "./definition.js";
import { toDetailedJson } from "./metadatum.js";

const { values: args } = parseArgs({
  options: {
    survey: { type: "string", default: "public/survey.json" },
    port: { type: "string", default: "8179" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, "..", "node_modules");

// URL prefix → directory served under it.
const ROUTES = [
  ["/modules/cardano-tessera-respond/", join(modules, "cardano-tessera-respond", "dist")],
  ["/modules/cip-179/", join(modules, "cip-179", "dist")],
  ["/cip179/", here],
  ["/", join(here, "preview")],
];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  try {
    if (path === "/preview.json") return send(res, 200, ".json", JSON.stringify(await preview()));
    const file = resolve(path === "/" ? "/index.html" : path);
    if (!file) return send(res, 404, ".txt", "not found");
    send(res, 200, extname(file), await readFile(file));
  } catch (error) {
    const status = error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500;
    send(res, status, ".txt", status === 404 ? "not found" : String(error.stack ?? error));
  }
});

server.listen(Number(args.port), "127.0.0.1", () => {
  console.log(`survey preview of ${args.survey}: http://localhost:${args.port}/`);
});

/** Everything the page needs: the files `build.js --out` writes, and the problems. */
async function preview() {
  const schemaBytes = await readFile(join(here, "free-text.schema.json"));
  const survey = JSON.parse(await readFile(args.survey, "utf8"));
  const { definition, conditions, translations, mapping, screening, problems } = buildSurvey(survey, {
    owner: { type: "key", keyHash: new Uint8Array(28) },
    endEpoch: 1000,
    freeTextSchema: { uri: "https://example.org/free-text.schema.json", hash: blake2b(schemaBytes, { dkLen: 32 }) },
  });
  const metadata = encodeMetadata({ type: "definitions", definitions: [cutLabels(definition)] });
  return {
    metadata: { 17: toDetailedJson(metadata.get(17n)) },
    conditions,
    translations,
    maxTextBytes: JSON.parse(schemaBytes).maxUtf8Bytes,
    screening: [...screening].map(([name, values]) => ({ name, values: [...values] })),
    mapping,
    problems,
  };
}

/** The file a URL path names, or undefined outside the served directories. */
function resolve(path) {
  for (const [prefix, dir] of ROUTES) {
    if (!path.startsWith(prefix)) continue;
    const file = normalize(join(dir, path.slice(prefix.length)));
    return file.startsWith(dir + sep) ? file : undefined;
  }
}

function send(res, status, ext, body) {
  res.writeHead(status, { "content-type": `${TYPES[ext] ?? "text/plain"}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
}
