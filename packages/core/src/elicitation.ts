// MCP elicitation (form mode) -> our Question model, and the human's answers -> the typed content object the
// MCP server expects. Shared by both provider adapters; pure, so it is unit-tested without any provider.
import type { Question } from './types.ts';

export interface ElicitationForm {
  questions: Question[];
  /** Convert answers keyed by field name into the content object. Throws a readable error on invalid input. */
  toContent(answers: Record<string, string[]>): Record<string, unknown>;
}

const TRUE = 'はい';
const FALSE = 'いいえ';

/** Returns null when the schema contains something we cannot present faithfully (then the caller must not guess). */
export function formFromElicitation(schema: unknown): ElicitationForm | null {
  const s = schema as { type?: string; properties?: Record<string, any>; required?: string[] } | null;
  if (!s || typeof s !== 'object' || typeof s.properties !== 'object' || s.properties === null) return null;
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const questions: Question[] = [];
  const converters = new Map<string, (v: string[]) => unknown>();

  for (const [name, prop] of Object.entries(s.properties)) {
    if (!prop || typeof prop !== 'object') return null;
    const base = {
      id: name,
      header: null,
      text: [prop.title ?? name, prop.description].filter(Boolean).join(' — '),
      isSecret: false,
      optional: !required.has(name),
    };
    const titled = (list: any[]): { label: string; value: string }[] => list.map((o) => ({ label: String(o.title ?? o.const), value: String(o.const) }));
    let choices: { label: string; value: string }[];
    let multi = false;

    if (prop.type === 'string' && Array.isArray(prop.enum)) {
      const names: unknown[] = Array.isArray(prop.enumNames) ? prop.enumNames : [];
      choices = prop.enum.map((v: unknown, i: number) => ({ label: String(names[i] ?? v), value: String(v) }));
    } else if (prop.type === 'string' && Array.isArray(prop.oneOf)) {
      choices = titled(prop.oneOf);
    } else if (prop.type === 'array' && prop.items && (Array.isArray(prop.items.enum) || Array.isArray(prop.items.anyOf))) {
      multi = true;
      choices = Array.isArray(prop.items.enum) ? prop.items.enum.map((v: unknown) => ({ label: String(v), value: String(v) })) : titled(prop.items.anyOf);
    } else if (prop.type === 'boolean') {
      questions.push({ ...base, multiSelect: false, allowFreeText: false, options: [{ label: TRUE, description: null }, { label: FALSE, description: null }] });
      converters.set(name, (v) => v[0] === TRUE);
      continue;
    } else if (prop.type === 'number' || prop.type === 'integer') {
      questions.push({ ...base, multiSelect: false, allowFreeText: true, options: [] });
      converters.set(name, (v) => {
        const n = Number(v[0]);
        if (!Number.isFinite(n) || (prop.type === 'integer' && !Number.isInteger(n))) throw new Error(`「${base.text}」には${prop.type === 'integer' ? '整数' : '数値'}を入力してください`);
        return n;
      });
      continue;
    } else if (prop.type === 'string') {
      questions.push({ ...base, multiSelect: false, allowFreeText: true, options: [] });
      converters.set(name, (v) => v[0]);
      continue;
    } else {
      return null;
    }

    const byLabel = new Map(choices.map((c) => [c.label, c.value]));
    if (byLabel.size !== choices.length) return null; // duplicate labels would make the answer ambiguous
    questions.push({ ...base, multiSelect: multi, allowFreeText: false, options: choices.map((c) => ({ label: c.label, description: null })) });
    converters.set(name, (v) => {
      const values = v.map((label) => {
        if (!byLabel.has(label)) throw new Error(`「${base.text}」に選択肢にない回答があります`);
        return byLabel.get(label)!;
      });
      return multi ? values : values[0];
    });
  }

  return {
    questions,
    toContent(answers) {
      const content: Record<string, unknown> = {};
      for (const q of questions) {
        const v = answers[q.id];
        if (!v || v.length === 0) {
          if (q.optional) continue;
          throw new Error(`未回答の項目があります: ${q.text}`);
        }
        content[q.id] = converters.get(q.id)!(v);
      }
      return content;
    },
  };
}
