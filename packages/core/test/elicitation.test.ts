import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore, formFromElicitation } from '../src/index.ts';
import type { AttentionAnswer } from '../src/index.ts';

const schema = {
  type: 'object',
  properties: {
    color: { type: 'string', title: 'Favorite color', oneOf: [{ const: 'r', title: 'Red' }, { const: 'b', title: 'Blue' }] },
    size: { type: 'string', enum: ['S', 'M'] },
    count: { type: 'integer', title: 'How many' },
    gift: { type: 'boolean' },
    note: { type: 'string', description: 'optional note' },
    tags: { type: 'array', items: { enum: ['x', 'y', 'z'] } },
  },
  required: ['color', 'count', 'gift'],
};

test('elicitation form: fields map to questions and answers map back to typed content', () => {
  const form = formFromElicitation(schema)!;
  assert.deepEqual(
    form.questions.map((q) => [q.id, q.optional, q.multiSelect, q.allowFreeText, q.options.map((o) => o.label)]),
    [
      ['color', false, false, false, ['Red', 'Blue']],
      ['size', true, false, false, ['S', 'M']],
      ['count', false, false, true, []],
      ['gift', false, false, false, ['はい', 'いいえ']],
      ['note', true, false, true, []],
      ['tags', true, true, false, ['x', 'y', 'z']],
    ],
  );
  assert.deepEqual(form.toContent({ color: ['Blue'], count: ['3'], gift: ['いいえ'], tags: ['x', 'z'] }), { color: 'b', count: 3, gift: false, tags: ['x', 'z'] });
  assert.throws(() => form.toContent({ color: ['Blue'], count: ['three'], gift: ['はい'] }), /整数/);
  assert.throws(() => form.toContent({ count: ['1'], gift: ['はい'] }), /未回答/);
});

test('elicitation form: a schema we cannot present faithfully is refused, not guessed', () => {
  assert.equal(formFromElicitation({ type: 'object', properties: { o: { type: 'object' } } }), null);
  assert.equal(formFromElicitation(null), null);
  const duplicateLabels = { type: 'object', properties: { c: { type: 'string', oneOf: [{ const: 'a', title: 'Same' }, { const: 'b', title: 'Same' }] } } };
  assert.equal(formFromElicitation(duplicateLabels), null);
});

test('declining is only possible where the provider allows it; optional fields may be left blank', () => {
  const core = new ControlCore({ store: new MemoryEventStore() });
  core.start();
  const projectId = core.addProject('p', 'C:\\work\\e');
  const s = core.createSession({ projectId, provider: 'codex', title: 't' });
  const form = formFromElicitation(schema)!;
  const sent: AttentionAnswer[] = [];
  const reply = (a: AttentionAnswer) => void sent.push(a);
  const plain = core.attentionOpen({ sessionId: s.id, requestId: '1', type: 'user_question', summary: 'q', questions: form.questions, reply });
  assert.equal(core.answer(plain, { kind: 'decline' }).ok, false);
  const elicit = core.attentionOpen({ sessionId: s.id, requestId: '2', type: 'user_question', summary: 'q', questions: form.questions, allowDecline: true, reply });
  assert.equal(core.answer(elicit, { kind: 'answers', answers: { color: ['Red'] } }).ok, false, 'required fields missing');
  assert.deepEqual(core.answer(elicit, { kind: 'answers', answers: { color: ['Red'], count: ['2'], gift: ['はい'] } }), { ok: true });
  const third = core.attentionOpen({ sessionId: s.id, requestId: '3', type: 'user_question', summary: 'q', questions: form.questions, allowDecline: true, reply });
  assert.deepEqual(core.answer(third, { kind: 'decline' }), { ok: true });
  assert.deepEqual(sent.map((a) => a.kind), ['answers', 'decline']);
});
