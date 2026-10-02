#!/usr/bin/env node
// Serves a local preview of the CIP-179 survey in the <tessera-respond>
// widget. The page checks the response the widget gives and shows it as an
// `answers.json` row.
//
//   node cip179/preview.js [--survey <file>] [--port <n>] [--sponsor]
//
// With `--sponsor`, the page can also submit the response through the sponsor
// functions (`functions/api/sponsor/`), run here with the config of
// `wrangler.jsonc` and `.dev.vars`. They only take responses to the survey
// published as SPONSOR_SURVEY, so use the survey it was built from.
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
    sponsor: { type: "boolean", default: false },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, "..", "node_modules");
const env = args.sponsor ? await sponsorEnv() : undefined;
const API = {
  "/api/sponsor": () => import("../functions/api/sponsor/index.js"),
  "/api/sponsor/submit": () => import("../functions/api/sponsor/submit.js"),
};

// URL prefix → directory served under it.
const ROUTES = [
  ["/modules/cardano-tessera-respond/", join(modules, "cardano-tessera-respond", "dist")],
  ["/modules/cip-179/", join(modules, "cip-179", "dist")],
  ["/modules/@noble/curves/", join(modules, "@noble", "curves")],
  ["/modules/@noble/hashes/", join(modules, "@noble", "hashes")],
  ["/cip179/", here],
  ["/", join(here, "preview")],
];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  try {
    if (path === "/preview.json") return send(res, 200, ".json", JSON.stringify(await preview()));
    if (env && req.method === "POST" && API[path]) return await callFunction(req, res, await API[path]());
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
  if (env) console.log(`responses can be submitted to ${env.SPONSOR_SURVEY} on ${env.SPONSOR_NETWORK}`);
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
    sponsor: env ? { network: env.SPONSOR_NETWORK, survey: env.SPONSOR_SURVEY } : null,
    screening: [...screening].map(([name, values]) => ({ name, values: [...values] })),
    mapping,
    problems,
  };
}

/** The sponsor's config: the vars of `wrangler.jsonc`, then `.dev.vars`. */
async function sponsorEnv() {
  const jsonc = await readFile(join(here, "..", "wrangler.jsonc"), "utf8");
  const { vars } = JSON.parse(jsonc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
  const devVars = await readFile(join(here, "..", ".dev.vars"), "utf8");
  for (const [, name, value] of devVars.matchAll(/^(\w+)="?(.*?)"?$/gm)) vars[name] = value;
  return vars;
}

/** Answers a request with a Pages Function's `onRequestPost`. */
async function callFunction(req, res, { onRequestPost }) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(new URL(req.url, "http://localhost"), {
    method: "POST",
    headers: req.headers,
    body: Buffer.concat(chunks),
  });
  const response = await onRequestPost({ request, env });
  res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
  res.end(Buffer.from(await response.arrayBuffer()));
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
