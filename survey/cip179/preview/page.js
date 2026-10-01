// The preview page: loads the survey built by `preview.js` into the widget,
// and checks each response it gives the way the export will read it.

import "/modules/cardano-tessera-respond/tessera-respond.es.js";
import { decodeMetadata, decodePayload, describeProblems, validateResponse } from "cip-179";

import { answersToRow, withoutHiddenAnswers } from "/cip179/answers.js";
import { fromDetailedJson, toCbor, toDetailedJson } from "/cip179/metadatum.js";

const MAX_TX_BYTES = 16384;
// Languages the widget has its own texts in; others show its buttons and
// hints in English until we give it `messages`.
const WIDGET_LOCALES = ["en", "fr"];
const STORAGE = "survey-preview.";

const $ = (selector) => document.querySelector(selector);

const response = await fetch("/preview.json");
if (!response.ok) {
  showError(`The survey couldn't be built:\n${await response.text()}`);
  throw new Error("no survey");
}
const built = await response.json();
const [definition] = decodeMetadata(new Map([[17n, fromDetailedJson(built.metadata[17])]])).definitions;

showProblems(built.problems);
showScreening(built.screening);

// Controls, remembered across reloads.
const languages = [built.translations.defaultLanguage, ...Object.keys(built.translations.translations)];
$("#locale").append(...languages.map((tag) => new Option(tag, tag)));
const locale = remembered("locale", languages);
const layout = remembered("layout", ["one-per-screen", "list"]);

const widget = $("tessera-respond");
widget.definition = definition;
widget.surveyRef = { txId: new Uint8Array(32), index: 0 };
widget.responder = { 4: { type: "key", keyHash: new Uint8Array(28).fill(1) } };
widget.tipEpoch = Number(definition.endEpoch) - 1;
widget.showRole = false;
widget.conditions = built.conditions;
widget.translations = built.translations;
widget.maxTextBytes = built.maxTextBytes;
widget.hiddenSchemas = definition.questions.flatMap((q) => (q.type === "custom" ? [q.methodSchema.uri] : []));
widget.stash = stash();
widget.messages = { respond: { signAndSubmit: "Preview response" } };
const showLocale = () => {
  widget.locale = locale.value;
  const note = $("#ui-language");
  note.hidden = WIDGET_LOCALES.includes(locale.value.split("-")[0]);
  note.textContent = `The widget has no ${locale.value} texts yet: its buttons and hints are in English.`;
};
showLocale();
locale.addEventListener("change", showLocale);
widget.layout = layout.value;
layout.addEventListener("change", () => (widget.layout = layout.value));

$("#forget").addEventListener("click", () => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${STORAGE}answers.`)) localStorage.removeItem(key);
    }
  } catch {}
  location.reload();
});

widget.addEventListener("tessera:response", (event) => showResponse(event.detail.payload));

// ----------------------------------------------------------------------------

/** Checks a label-17 payload from the widget and shows it as an answers row. */
function showResponse(payload) {
  const checks = [];
  const check = (ok, text) => checks.push({ ok, text });

  const size = toCbor(new Map([[17n, payload]])).length;
  check(size <= MAX_TX_BYTES, `${size} bytes of metadata (a transaction is at most ${MAX_TX_BYTES})`);

  const [decoded] = decodePayload(payload).responses;
  const problems = describeProblems(validateResponse(definition, decoded));
  check(problems.length === 0, problems.length === 0 ? "valid CIP-179 response" : problems.join("; "));

  const { answers, hidden } = withoutHiddenAnswers(definition, built.conditions, decoded.answers.answers);
  const names = (indices) => indices.map((i) => built.mapping.questions[i].name).join(", ");
  check(hidden.length === 0, hidden.length === 0 ? "no answer to a hidden question" : `answers hidden questions: ${names(hidden)}`);

  const { row, problems: unmapped } = answersToRow(answers, built.mapping);
  check(unmapped.length === 0, unmapped.length === 0 ? "every answer maps to answers.json" : unmapped.join("; "));

  $("#checks").replaceChildren(
    ...checks.map(({ ok, text }) => {
      const li = document.createElement("li");
      li.className = ok ? "check-ok" : "check-fail";
      li.textContent = `${ok ? "✓" : "✗"} ${text}`;
      return li;
    }),
  );
  $("#row").textContent = JSON.stringify(row, null, 2);
  $("#payload").textContent = JSON.stringify({ 17: toDetailedJson(payload) }, null, 2);
  $("#result").hidden = false;
  $("#result").scrollIntoView({ behavior: "smooth" });
}

function showProblems(problems) {
  if (problems.length === 0) return;
  const count = (level) => problems.filter((p) => p.level === level).length;
  const summary = [
    [count("error"), "error"],
    [count("warning"), "warning"],
    [count("info"), "note"],
  ]
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}${n > 1 ? "s" : ""}`)
    .join(", ");
  const details = $("#problems");
  details.querySelector("summary").textContent =
    `${summary} from the builder` + (count("error") > 0 ? " (labels over 64 bytes are cut here)" : "");
  details.querySelector("ul").replaceChildren(
    ...problems.map((p) => {
      const li = document.createElement("li");
      li.className = `level-${p.level}`;
      li.textContent = `${p.level}: ${p.question ? `${p.question}: ` : ""}${p.message}`;
      return li;
    }),
  );
  details.hidden = false;
}

function showScreening(screening) {
  if (screening.length === 0) return;
  const answers = screening.map(({ name, values }) => `${name} = ${values.map((v) => JSON.stringify(v)).join(" or ")}`);
  const note = $("#screening");
  note.textContent = `Respondents answering ${answers.join(", ")} are screened out by the site, before the survey; those options aren't in it.`;
  note.hidden = false;
}

function showError(text) {
  const p = $("#error");
  p.textContent = text;
  p.hidden = false;
}

/** A select whose value is kept in localStorage. */
function remembered(name, values) {
  const select = $(`#${name}`);
  const saved = storage("getItem", STORAGE + name);
  if (values.includes(saved)) select.value = saved;
  select.addEventListener("change", () => storage("setItem", STORAGE + name, select.value));
  return select;
}

/** The widget's unsent answers, kept in localStorage. */
function stash() {
  const key = (surveyKey) => `${STORAGE}answers.${surveyKey}`;
  return {
    get: (surveyKey) => {
      const json = storage("getItem", key(surveyKey));
      try {
        return json == null ? undefined : JSON.parse(json);
      } catch {
        return undefined;
      }
    },
    set: (surveyKey, form) => storage("setItem", key(surveyKey), JSON.stringify(form)),
    delete: (surveyKey) => storage("removeItem", key(surveyKey)),
  };
}

function storage(method, ...args) {
  try {
    return localStorage[method](...args);
  } catch {
    return undefined;
  }
}
