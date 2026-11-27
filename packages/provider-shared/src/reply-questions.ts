// Questions read from an agent's prose reply.
//
// A reply often asks more than one thing at once: "adopt EXP-2, drop it, or run EXP-3?" and, further down, "switch the
// author address, or put it back?". Read as one question, the human could pick only one answer for both decisions. So
// the helper model is asked for one question per decision, each with only the options that answer THAT decision, and
// whether its options exclude each other (pick one) or can be taken together (pick several).
//
// Split of work:
//   - the helper model decides what belongs together (it reads the meaning; the rules below are its instructions)
//   - this module turns its JSON into a clean, bounded list (pure, no model): it never invents a split by itself, it only
//     cleans up what came back (empty, duplicate and over-long parts) so the screen always gets something sane
//   - a closed question ("進めてよいですか") offers no options in its words, but can be answered with yes or no: those two
//     are added, when the model says so (`yesNo`) or the question's own ending plainly asks for it (isClosedQuestion)
//
// Kept small on purpose: the inbox shows every question of a reply in one ticket, answered with one "send" button.

export interface ReplyOption {
  label: string;
  description: string | null;
}

/** One decision the reply leaves to the human. */
export interface ReplyQuestion {
  text: string;
  /** The options can be taken together (several things to do), not alternatives of one choice. */
  multiSelect: boolean;
  options: ReplyOption[];
}

/** At most this many separate decisions from one reply, and this many options for each. */
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 6;

/** The JSON shape the helper model is asked to give, as it appears in its instructions. */
export const QUESTIONS_SHAPE = '"questions": [{"text": "質問文", "multiSelect": true または false, "yesNo": true または false, "options": [{"label": "短い選択肢名", "description": "補足または null"}]}]';

/** The helper model's instructions for `questions`. */
export const QUESTIONS_RULES = [
  'questions: 返答が、人間の選択・判断・回答を求めて終わっている場合だけ入れる。「AとBどちらにしますか」「進めてよいですか」など。なければ空配列。',
  'questions は「決めること」1つにつき1問にする。返答が別々のことを決めさせている（対象・話題・課題が違う選択肢の組がある）なら、選択肢を一つの問題にまとめず、決めることごとに別の問題に分ける。例: 「EXP-2を採用／EXP-2を破棄／EXP-3を実施」と「作者アドレスを切り替える／作者アドレスの設定を戻す」は、決めることが違うので2問にする。',
  '1問の options には、その問いへの答えになるものだけを入れる（返答の言葉を使う、最大6個）。text はその問いだけを短く書く（ほかの問いの内容を混ぜない）。返答に選択肢が示されていなければ options は空配列。',
  'multiSelect: その問いの選択肢がどれか1つを選ぶ択一なら false。いくつ選んでもよい（並べて実行できる別々の作業の候補など）なら true。',
  'yesNo: 「はい」か「いいえ」で答えられる問い（「進めてよいですか」「マージしますか」「この方針で大丈夫ですか」など）なら true。選択肢の中から選ぶ問いや、内容を答える問い（「どちらにしますか」「名前は何にしますか」）なら false。',
].join('\n');

/** The two answers a closed question is given when it offers none of its own. */
export const YES_NO: ReplyOption[] = [
  { label: 'はい', description: null },
  { label: 'いいえ', description: null },
];

/** Words that make a question ask for something other than yes or no: which one, what, how, or this-or-that. */
const OPEN_WORDS = /どちら|どっち|どれ|どの|何|なに|なん|いつ|どこ|だれ|誰|どう|どんな|いくつ|いくら|それとも|\b(?:which|what|how|when|where|who|why)\b|\bor\b/i;
/** Endings that ask for permission or confirmation. */
const CLOSED_JA = /(?:て|で)(?:も)?(?:よい|良い|いい|よろしい|大丈夫|問題ない|構わない)(?:です|でしょう)?か|(?:て|で)(?:も)?(?:構いません|差し支えありません)か|(?:し|でき|進め|始め|続け|入れ|作り|消し|戻し|使い|直し|分け|出し)(?:ます|ましょう)か|(?:です|でしょう)か$/;
const CLOSED_EN = /^(?:should|shall|can|could|may|do|does|did|is|are|was|were|would|will|have|has)\b/i;

/**
 * The question plainly asks for a yes or a no, by its own words: a request for permission or confirmation, with no
 * "which", "what" or "this or that" in it. Used only when the model gave no options and did not say (`yesNo`).
 */
export function isClosedQuestion(text: string): boolean {
  const t = text.trim().replace(/[?？。!！\s]+$/u, '');
  if (!t || OPEN_WORDS.test(t)) return false;
  return CLOSED_JA.test(t) || CLOSED_EN.test(t);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The questions in the helper model's JSON, cleaned up. Accepts the older single `question` too.
 * An option is kept only in the first question that names it; two questions with the same words become one.
 */
export function readReplyQuestions(j: unknown): ReplyQuestion[] {
  const o = (j && typeof j === 'object' ? j : {}) as { questions?: unknown; question?: unknown };
  const raw: unknown[] = Array.isArray(o.questions) ? o.questions : o.question ? [o.question] : [];
  const out: ReplyQuestion[] = [];
  const usedLabels = new Set<string>();
  for (const q of raw) {
    if (out.length >= MAX_QUESTIONS) break;
    const x = (q && typeof q === 'object' ? q : {}) as { text?: unknown; multiSelect?: unknown; yesNo?: unknown; options?: unknown };
    const text = str(x.text);
    if (!text) continue;
    const options: ReplyOption[] = [];
    for (const r of Array.isArray(x.options) ? x.options : []) {
      const label = str((r as { label?: unknown })?.label);
      if (!label || usedLabels.has(label)) continue;
      usedLabels.add(label);
      options.push({ label, description: str((r as { description?: unknown })?.description) });
      if (options.length >= MAX_OPTIONS) break;
    }
    const same = out.find((p) => p.text === text);
    if (same) {
      // The model split one decision in two under the same words: put it back together.
      same.options.push(...options.slice(0, MAX_OPTIONS - same.options.length));
      continue;
    }
    // A closed question with no options of its own is answered with yes or no (typed words still win over them).
    const closed = options.length === 0 && (x.yesNo === true || (x.yesNo !== false && isClosedQuestion(text)));
    out.push({ text, multiSelect: x.multiSelect === true && options.length > 1, options: closed ? YES_NO.map((o) => ({ ...o })) : options });
  }
  return out;
}
