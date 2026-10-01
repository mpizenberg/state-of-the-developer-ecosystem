// Turns the SurveyJS survey (`survey.json`) into what the CIP-179 survey
// needs:
//
// - `definition`: the CIP-179 survey definition, with the English text;
// - `conditions` and `translations`: the documents `<tessera-respond>` takes
//   beside the definition, for conditional display and the other languages;
// - `mapping`: for each CIP-179 question, the SurveyJS question (and value of
//   each option) it comes from, so responses can be turned back into the
//   SurveyJS answers format the report reads;
// - `screening`: the answers that end the survey without recording anything
//   (SurveyJS "complete" triggers). They are left out of the definition, and
//   the site asks them before showing the form.
//
// Along the way it collects `problems`: anything that can't be expressed in
// CIP-179 or in the widget, or that changes how the survey behaves. Problems
// of level "error" must be fixed in `survey.json` before publishing.

import {
  MAX_CHUNK_BYTES,
  Role,
  SPEC_VERSION,
  describeProblem,
  problemSeverity,
  utf8ByteLength,
  validateDefinition,
} from "cip-179";

export const DEFAULT_LANGUAGE = "en";

// Texts SurveyJS provides itself, for the locales we use.
const BUILT_IN_TEXTS = {
  other: { default: "Other", ja: "その他", vi: "Khác" },
  none: { default: "None", ja: "なし", vi: "Không có" },
  otherComment: {
    default: "Other (please specify)",
    ja: "その他（具体的に記入してください）",
    vi: "Khác (vui lòng ghi rõ)",
  },
};

/**
 * @param {object} survey the SurveyJS survey JSON
 * @param {object} options
 * @param {import("cip-179").Credential} options.owner
 * @param {number} options.endEpoch
 * @param {{ uri: string, hash: Uint8Array }} options.freeTextSchema anchor of the free-text answer schema
 */
export function buildSurvey(survey, { owner, endEpoch, freeTextSchema }) {
  const problems = [];
  const report = (level, question, message) => problems.push({ level, question, message });

  const screening = readTriggers(survey.triggers ?? [], report);
  const elements = (survey.pages ?? []).flatMap((page) => page.elements ?? []);

  // One entry per CIP-179 question, in order.
  const entries = [];
  const mainEntry = new Map();
  for (const element of elements) {
    const built = questionEntries(element, screening, freeTextSchema, report);
    if (built.length > 0) mainEntry.set(element.name, entries.length);
    entries.push(...built);
  }

  // Display conditions, once every question has its position.
  const conditions = {};
  entries.forEach((entry, index) => {
    const rule = entry.condition && resolveCondition(entry.condition, index, entries, mainEntry);
    if (typeof rule === "string") report("error", entry.name, `visibleIf: ${rule}; the condition is left out`);
    else if (rule) conditions[index] = rule;
    const required = entry.required && !rule;
    if (entry.required && rule) {
      report("warning", entry.name, "is required but can be hidden; it is optional on chain");
    }
    entry.question = required ? { ...entry.question, required: true } : entry.question;
  });

  entries.forEach((entry) =>
    [...(entry.labels ?? []), ...(entry.levels ?? [])].forEach((label) => {
      const text = defaultText(label);
      if (utf8ByteLength(text) > MAX_CHUNK_BYTES) {
        report("error", entry.name, `option label is over ${MAX_CHUNK_BYTES} bytes: "${text}"`);
      }
    }),
  );

  const definition = {
    specVersion: SPEC_VERSION,
    owner,
    title: defaultText(survey.title),
    description: defaultText(survey.description ?? ""),
    eligibleRoles: [Role.Keyholder],
    endEpoch,
    submissionMode: { type: "public" },
    questions: entries.map((e) => e.question),
  };
  for (const p of validateDefinition(definition)) {
    // Long labels are already reported above, with their text.
    if (p.code === "question.labelTooLong") continue;
    report(problemSeverity(p), undefined, describeProblem(p));
  }

  return {
    definition,
    conditions,
    translations: buildTranslations(survey, entries),
    mapping: { questions: entries.map((e) => e.mapping) },
    screening,
    problems,
  };
}

// ----------------------------------------------------------------------------
// Questions

function questionEntries(element, screening, freeTextSchema, report) {
  const name = element.name;
  const condition = element.visibleIf ? parseCondition(element.visibleIf) : undefined;
  if (typeof condition === "string") report("error", name, `visibleIf "${element.visibleIf}": ${condition}`);
  const shown = typeof condition === "object" ? condition : undefined;
  const prompt = joinTexts(element.title ?? name, element.description);
  const required = element.isRequired === true;

  const entry = (question, mapping, fields = {}) => ({
    name: mapping.field ? `${mapping.name}.${mapping.field}` : mapping.name,
    question,
    mapping,
    prompt: fields.prompt ?? prompt,
    labels: fields.labels,
    levels: fields.levels,
    condition: "condition" in fields ? fields.condition : shown,
    required: fields.required ?? false,
  });
  const freeText = (mapping, textPrompt, fields) =>
    entry(
      { type: "custom", prompt: defaultText(textPrompt), methodSchema: freeTextSchema },
      mapping,
      { prompt: textPrompt, ...fields },
    );

  if (element.choicesOrder === "random" || element.rowsOrder === "random") {
    report("info", name, "random option order isn't supported; options keep the order of survey.json");
  }

  switch (element.type) {
    case "radiogroup":
    case "dropdown":
    case "checkbox":
    case "tagbox":
    case "ranking": {
      const choices = choiceList(element, screening.get(name));
      const labels = choices.map((c) => c.text);
      const options = { type: "options", labels: labels.map(defaultText) };
      const mapping = { name, values: choices.map((c) => c.value) };
      const count = labels.length;
      let question;
      if (element.type === "radiogroup" || element.type === "dropdown") {
        question = { type: "singleChoice", prompt: defaultText(prompt), options };
      } else if (element.type === "ranking") {
        const partial = element.selectToRankEnabled === true;
        question = {
          type: "ranking",
          prompt: defaultText(prompt),
          options,
          minRanked: partial ? (element.minSelectedChoices || 1) : count,
          maxRanked: partial ? (element.maxSelectedChoices || count) : count,
        };
      } else {
        question = {
          type: "multiSelect",
          prompt: defaultText(prompt),
          options,
          minSelections: element.minSelectedChoices || 1,
          maxSelections: element.maxSelectedChoices || count,
        };
      }
      const result = [entry(question, mapping, { labels, required })];
      if (hasOther(element)) {
        // SurveyJS keeps the "Other" text in `<name>-Comment`.
        result.push(
          freeText({ name: `${name}-Comment` }, element.otherPlaceholder ?? BUILT_IN_TEXTS.otherComment, {
            condition: { name, any: true, values: ["other"] },
          }),
        );
      }
      if (element.showCommentArea) {
        result.push(freeText({ name: `${name}-Comment` }, element.commentText ?? BUILT_IN_TEXTS.otherComment));
      }
      return result;
    }

    case "matrix": {
      // Several items rated on the same scale: a CIP-179 rating question,
      // which rates at least 2 items.
      const rows = (element.rows ?? []).map(item);
      const columns = (element.columns ?? []).map(item);
      if (rows.length < 2) {
        report("error", name, "a matrix needs at least 2 rows on chain; use a rating question for a single item");
        return [];
      }
      const labels = rows.map((r) => r.text);
      const levels = columns.map((c) => c.text);
      const question = {
        type: "rating",
        prompt: defaultText(prompt),
        options: { type: "options", labels: labels.map(defaultText) },
        scale: { type: "labels", labels: levels.map(defaultText) },
        requireAll: element.isAllRowRequired === true,
      };
      const mapping = { name, values: rows.map((r) => r.value), levels: columns.map((c) => c.value) };
      return [entry(question, mapping, { labels, levels, required })];
    }

    case "rating": {
      // A single item: CIP-179 ratings need at least 2 items, so named
      // levels become one option per level, and numbers a numeric range.
      if (Array.isArray(element.rateValues) && element.rateValues.length > 0) {
        const levels = element.rateValues.map(item);
        const labels = levels.map((l) => l.text);
        const question = {
          type: "singleChoice",
          prompt: defaultText(prompt),
          options: { type: "options", labels: labels.map(defaultText) },
        };
        return [entry(question, { name, values: levels.map((l) => l.value) }, { labels, required })];
      }
      const question = {
        type: "numericRange",
        prompt: defaultText(prompt),
        constraints: {
          min: BigInt(element.rateMin ?? 1),
          max: BigInt(element.rateMax ?? 5),
          step: BigInt(element.rateStep ?? 1),
        },
      };
      return [entry(question, { name }, { required })];
    }

    case "text":
    case "comment":
      if (element.inputType && element.inputType !== "text") {
        report("warning", name, `input type "${element.inputType}" is collected as free text`);
      }
      return [freeText({ name }, prompt, { required })];

    case "multipletext":
      // One free-text question per field.
      return (element.items ?? []).map((item) =>
        freeText({ name, field: item.name }, joinTexts(element.title ?? name, item.title ?? item.name), {
          required: required || item.isRequired === true,
        }),
      );

    case "html":
      report("info", name, "HTML content isn't a question; it is left to the site");
      return [];

    default:
      report("error", name, `question type "${element.type}" isn't supported`);
      return [];
  }
}

const hasOther = (element) => element.showOtherItem === true || element.hasOther === true;
const hasNone = (element) => element.showNoneItem === true || element.hasNone === true;

/** A SurveyJS choice, row, column or rate value, as `{ value, text }`. */
const item = (c) =>
  typeof c === "object" && c !== null ? { value: c.value, text: c.text ?? String(c.value) } : { value: c, text: String(c) };

/** The options of a choice question, in their on-chain order. */
function choiceList(element, excluded = new Set()) {
  const choices = (element.choices ?? []).map(item).filter((c) => !excluded.has(c.value));
  if (element.choicesOrder === "asc" || element.choicesOrder === "desc") {
    // SurveyJS sorts by displayed text; on chain we sort by the English text.
    choices.sort((a, b) => defaultText(a.text).localeCompare(defaultText(b.text), DEFAULT_LANGUAGE));
    if (element.choicesOrder === "desc") choices.reverse();
  }
  if (hasOther(element)) choices.push({ value: "other", text: element.otherText ?? BUILT_IN_TEXTS.other });
  if (hasNone(element)) choices.push({ value: "none", text: element.noneText ?? BUILT_IN_TEXTS.none });
  return choices;
}

// ----------------------------------------------------------------------------
// Conditions and triggers

/**
 * A SurveyJS expression testing one question's value, as
 * `{ name, any, values }`: shown when any of `values` is selected (`any`), or
 * when none of them is. Anything else is unsupported (returns a reason).
 */
export function parseCondition(expression) {
  const match = /^\s*\{([\w-]+)\}\s*(=|==|<>|!=|contains|notcontains|anyof|noneof)\s*(.+?)\s*$/i.exec(expression);
  if (!match) return "only tests of one question's value are supported";
  const [, name, operator, operand] = match;
  const values = parseValues(operand);
  if (!values) return `can't read the value ${operand}`;
  const any = ["=", "==", "contains", "anyof"].includes(operator.toLowerCase());
  return { name, any, values };
}

function parseValues(operand) {
  const one = (s) => {
    const quoted = /^(['"])(.*)\1$/.exec(s.trim());
    if (quoted) return quoted[2];
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };
  const list = /^\[(.*)\]$/.exec(operand.trim());
  const values = list ? list[1].split(",").map(one) : [one(operand)];
  return values.every((v) => v !== undefined) ? values : undefined;
}

function resolveCondition(condition, index, entries, mainEntry) {
  const source = mainEntry.get(condition.name);
  if (source === undefined) return `${condition.name} isn't a question`;
  if (source >= index) return `${condition.name} doesn't come before this question`;
  const { question, mapping } = entries[source];
  if (question.type !== "singleChoice" && question.type !== "multiSelect") {
    return `${condition.name} isn't a single- or multiple-choice question`;
  }
  const options = [];
  for (const value of condition.values) {
    const option = mapping.values.indexOf(value);
    if (option < 0) return `${condition.name} has no option "${value}"`;
    options.push(option);
  }
  return condition.any ? { question: source, anyOf: options } : { question: source, noneOf: options };
}

/** "complete" triggers, as the excluded values of each question. */
function readTriggers(triggers, report) {
  const screening = new Map();
  for (const trigger of triggers) {
    const condition = trigger.type === "complete" ? parseCondition(trigger.expression ?? "") : undefined;
    if (!condition || typeof condition === "string" || !condition.any) {
      report("error", undefined, `trigger ${JSON.stringify(trigger)} isn't supported`);
      continue;
    }
    const excluded = screening.get(condition.name) ?? new Set();
    condition.values.forEach((v) => excluded.add(v));
    screening.set(condition.name, excluded);
  }
  return screening;
}

// ----------------------------------------------------------------------------
// Texts and translations

/** A SurveyJS text: a string, or an object of strings keyed by locale. */
function defaultText(text) {
  if (typeof text === "string") return text;
  return text?.default ?? text?.[DEFAULT_LANGUAGE] ?? "";
}

function localText(text, locale) {
  return typeof text === "object" && text !== null ? text[locale] : undefined;
}

function locales(text) {
  return typeof text === "object" && text !== null ? Object.keys(text) : [];
}

/** `a` and `b` as paragraphs, per locale, falling back to each one's default. */
function joinTexts(a, b) {
  if (!b) return a;
  const joined = { default: `${defaultText(a)}\n\n${defaultText(b)}` };
  for (const locale of new Set([...locales(a), ...locales(b)])) {
    if (locale === "default") continue;
    joined[locale] = `${localText(a, locale) ?? defaultText(a)}\n\n${localText(b, locale) ?? defaultText(b)}`;
  }
  return joined;
}

function buildTranslations(survey, entries) {
  const all = new Set();
  const collect = (text) => locales(text).forEach((l) => all.add(l));
  collect(survey.title);
  collect(survey.description);
  for (const entry of entries) {
    collect(entry.prompt);
    (entry.labels ?? []).forEach(collect);
    (entry.levels ?? []).forEach(collect);
  }
  all.delete("default");
  all.delete(DEFAULT_LANGUAGE);

  const translations = {};
  for (const locale of [...all].sort()) {
    const questions = entries.map((entry) => {
      const translation = {};
      const prompt = localText(entry.prompt, locale);
      if (prompt !== undefined) translation.prompt = prompt;
      // Labels are all or nothing: untranslated ones keep their default text.
      const translated = (labels = []) =>
        labels.some((label) => localText(label, locale) !== undefined)
          ? labels.map((label) => localText(label, locale) ?? defaultText(label))
          : undefined;
      const options = translated(entry.labels);
      if (options) translation.options = options;
      const ratingLabels = translated(entry.levels);
      if (ratingLabels) translation.ratingLabels = ratingLabels;
      return translation;
    });
    translations[locale] = {
      ...(localText(survey.title, locale) && { title: localText(survey.title, locale) }),
      ...(localText(survey.description, locale) && { description: localText(survey.description, locale) }),
      questions,
    };
  }
  return { defaultLanguage: DEFAULT_LANGUAGE, translations };
}
