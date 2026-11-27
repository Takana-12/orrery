// The questions read from a reply are cleaned up without a model: bounded, no duplicates, the old single shape accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OPTIONS, MAX_QUESTIONS, readReplyQuestions } from '../src/reply-questions.ts';

const opt = (label: string, description: string | null = null) => ({ label, description });

test('separate decisions stay separate questions, each with only its own options', () => {
  const got = readReplyQuestions({ questions: [
    { text: '見比べの結果、どうしますか', multiSelect: false, options: [opt('EXP-2を採用', '採用する場合'), opt('EXP-2を破棄'), opt('EXP-3を実施')] },
    { text: '作者アドレスをどうしますか', options: [opt('作者アドレスを切り替える'), opt('作者アドレスの設定を戻す')] },
  ] });
  assert.deepEqual(got.map((q) => [q.text, q.options.map((o) => o.label)]), [
    ['見比べの結果、どうしますか', ['EXP-2を採用', 'EXP-2を破棄', 'EXP-3を実施']],
    ['作者アドレスをどうしますか', ['作者アドレスを切り替える', '作者アドレスの設定を戻す']],
  ]);
  assert.equal(got[0]!.options[0]!.description, '採用する場合');
  assert.deepEqual(got.map((q) => q.multiSelect), [false, false]);
});

test('the older single question is still read', () => {
  assert.deepEqual(readReplyQuestions({ question: { text: 'AとBどちらにしますか', options: [opt('A'), opt('B')] } }), [
    { text: 'AとBどちらにしますか', multiSelect: false, options: [opt('A'), opt('B')] },
  ]);
  assert.deepEqual(readReplyQuestions({ question: null }), []);
  assert.deepEqual(readReplyQuestions(null), []);
});

test('an option is offered once, and one decision split under the same words is put back together', () => {
  const got = readReplyQuestions({ questions: [
    { text: 'どれにしますか', options: [opt('A'), opt('B')] },
    { text: 'どれにしますか', options: [opt('C')] },
    { text: 'ほかには', options: [opt('A'), opt('D')] },
  ] });
  assert.deepEqual(got.map((q) => [q.text, q.options.map((o) => o.label)]), [['どれにしますか', ['A', 'B', 'C']], ['ほかには', ['D']]]);
});

test('empty parts are dropped and the list is bounded', () => {
  const many = Array.from({ length: 10 }, (_, i) => opt(`o${i}`));
  const got = readReplyQuestions({ questions: [
    { text: '  ', options: [opt('x')] },
    ...Array.from({ length: 6 }, (_, i) => ({ text: `q${i}`, options: many.map((o) => ({ ...o, label: `${i}-${o.label}` })).concat([opt('')]) })),
  ] });
  assert.equal(got.length, MAX_QUESTIONS);
  assert.ok(got.every((q) => q.options.length === MAX_OPTIONS));
});

test('several-at-once is kept only when there is more than one option to take', () => {
  const got = readReplyQuestions({ questions: [
    { text: 'どれをやりますか', multiSelect: true, options: [opt('A'), opt('B')] },
    { text: '進めますか', multiSelect: true, options: [opt('はい')] },
  ] });
  assert.deepEqual(got.map((q) => q.multiSelect), [true, false]);
});

test('a closed question with no options of its own is answered with yes or no', () => {
  const yn = ['はい', 'いいえ'];
  const labels = (q: { text: string; yesNo?: boolean; options?: unknown[] }) => readReplyQuestions({ questions: [{ options: [], ...q }] })[0]!.options.map((o) => o.label);
  // the model says so
  assert.deepEqual(labels({ text: 'この内容で反映しますか', yesNo: true }), yn);
  // the model did not say: the question's own ending asks for permission or confirmation
  for (const text of ['この方針で進めてよいですか？', 'このまま進めても大丈夫でしょうか', 'PRをマージしますか？', '古いブランチを消しても構いませんか', 'これで問題ないですか', 'Should I open a PR?']) {
    assert.deepEqual(labels({ text }), yn, text);
  }
  // asking which, what or how, or this-or-that, is not a yes or no
  for (const text of ['AとBどちらにしますか？', '名前は何にしますか', 'どう進めましょうか', 'AにしますかそれともBにしますか', 'Which branch should I use?', 'Should I use A or B?', '気になる点を教えてください']) {
    assert.deepEqual(labels({ text }), [], text);
  }
  // the model's own "no" wins over the ending, and options of its own are never replaced
  assert.deepEqual(labels({ text: '進めてよいですか', yesNo: false }), []);
  assert.deepEqual(labels({ text: '進めてよいですか', yesNo: true, options: [{ label: 'すぐ進める' }, { label: '明日にする' }] }), ['すぐ進める', '明日にする']);
  const [q] = readReplyQuestions({ questions: [{ text: '進めてよいですか', multiSelect: true, options: [] }] });
  assert.equal(q!.multiSelect, false, 'yes and no exclude each other');
});
