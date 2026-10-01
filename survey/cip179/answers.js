// Conversions between CIP-179 answers and SurveyJS answer rows (the format of
// `<year>/data/answers.json`), through the mapping made by `definition.js`.
//
// `answersToRow` is what the export uses. `rowToAnswers` goes the other way;
// it lets us test the mapping on past answers.

import { decodeChunkedText, encodeChunkedText } from "cip-179";

/**
 * A SurveyJS answer row → CIP-179 answer items. Values the mapping doesn't
 * know are left out and reported.
 */
export function rowToAnswers(row, definition, mapping) {
  const answers = [];
  const problems = [];
  definition.questions.forEach((question, questionIndex) => {
    const { name, field, values, levels } = mapping.questions[questionIndex];
    const raw = field ? row[name]?.[field] : row[name];
    if (raw === undefined || raw === null || raw === "") return;
    const option = (value) => {
      const index = values.indexOf(value);
      if (index < 0) problems.push(`${name}: unknown value ${JSON.stringify(value)}`);
      return index;
    };
    switch (question.type) {
      case "singleChoice": {
        const optionIndex = option(raw);
        if (optionIndex >= 0) answers.push({ type: "singleChoice", questionIndex, optionIndex });
        return;
      }
      case "multiSelect":
      case "ranking": {
        const indices = raw.map(option).filter((i) => i >= 0);
        if (indices.length === 0) return;
        answers.push(
          question.type === "ranking"
            ? { type: "ranking", questionIndex, ranking: indices }
            : { type: "multiSelect", questionIndex, optionIndices: indices },
        );
        return;
      }
      case "rating": {
        // `{ row value: column value }`, rated by the column's position.
        const ratings = [];
        for (const [rowValue, columnValue] of Object.entries(raw)) {
          // Object keys are strings, whatever the row values are.
          const optionIndex = option(values.find((v) => String(v) === rowValue) ?? rowValue);
          const level = levels.indexOf(columnValue);
          if (level < 0) problems.push(`${name}: unknown level ${JSON.stringify(columnValue)}`);
          if (optionIndex >= 0 && level >= 0) ratings.push({ optionIndex, rating: BigInt(level) });
        }
        if (ratings.length > 0) answers.push({ type: "rating", questionIndex, ratings });
        return;
      }
      case "numericRange":
        answers.push({ type: "numeric", questionIndex, value: BigInt(raw) });
        return;
      case "custom":
        answers.push({ type: "custom", questionIndex, value: encodeChunkedText(String(raw)) });
        return;
      default:
        problems.push(`${name}: question type ${question.type} isn't mapped`);
    }
  });
  return { answers, problems };
}

/** CIP-179 answer items → a SurveyJS answer row. */
export function answersToRow(answers, mapping) {
  const row = {};
  const problems = [];
  for (const answer of answers) {
    const { name, field, values, levels } = mapping.questions[answer.questionIndex];
    let value;
    switch (answer.type) {
      case "singleChoice":
        value = values[answer.optionIndex];
        break;
      case "multiSelect":
        value = answer.optionIndices.map((i) => values[i]);
        break;
      case "ranking":
        value = answer.ranking.map((i) => values[i]);
        break;
      case "rating":
        value = Object.fromEntries(answer.ratings.map((r) => [values[r.optionIndex], levels[Number(r.rating)]]));
        break;
      case "numeric":
        value = Number(answer.value);
        break;
      case "custom":
        try {
          value = decodeChunkedText(answer.value);
        } catch {
          problems.push(`${name}: the answer isn't text`);
          continue;
        }
        break;
      default:
        problems.push(`${name}: answer type ${answer.type} isn't mapped`);
        continue;
    }
    if (field) row[name] = { ...row[name], [field]: value };
    else row[name] = value;
  }
  return { row, problems };
}

/**
 * Leaves out the answers to questions the conditions hide, as the widget
 * would have. Responses submitted with other tools may answer them anyway.
 */
export function withoutHiddenAnswers(definition, conditions, answers) {
  const byQuestion = new Map(answers.map((a) => [a.questionIndex, a]));
  const hidden = [];
  definition.questions.forEach((_, index) => {
    const rule = conditions[index];
    if (!rule) return void hidden.push(false);
    const source = hidden[rule.question] ? undefined : byQuestion.get(rule.question);
    const selected =
      source?.type === "singleChoice" ? [source.optionIndex] : source?.type === "multiSelect" ? source.optionIndices : [];
    const matched = selected.some((o) => (rule.anyOf ?? rule.noneOf).includes(o));
    hidden.push(rule.anyOf ? !matched : matched);
  });
  return {
    answers: answers.filter((a) => !hidden[a.questionIndex]),
    hidden: answers.filter((a) => hidden[a.questionIndex]).map((a) => a.questionIndex),
  };
}
