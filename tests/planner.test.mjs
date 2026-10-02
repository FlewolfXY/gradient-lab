import test from 'node:test';
import assert from 'node:assert/strict';
import { planMusicEdit } from '../server/planner.js';

const env = { MODEL_API_KEY: 'test-secret-do-not-return' };
const input = { text: '后半段伴奏别那么挤，给画面留点呼吸', scope: 'all', lockMelody: true, tempo: 80, bars: 16 };
const plan = { v: 1, scope: 'secondHalf', lockMelody: true, operations: [{ type: 'sparser', amount: 0.5 }] };
function mockFetch(result, options = {}) {
  return async (_url, request) => {
    options.onRequest?.(_url, request);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: options.finish ?? 'stop', message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }],
      usage: options.usage ?? { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    }), { status: options.status ?? 200 });
  };
}

test('DeepSeek receives only bounded text/settings; ready output is validated and factually summarized', async () => {
  let observed;
  const result = await planMusicEdit({ ...input, image: 'private-image', tracks: 'private-score' }, env, {
    fetchImpl: mockFetch({ status: 'ready', plan }, { onRequest: (url, request) => { observed = { url, request }; } }),
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'deepseek');
  assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(result.plan, plan);
  assert.match(result.summary, /后半段.*伴奏/);
  assert.equal(JSON.stringify(result).includes(env.MODEL_API_KEY), false);
  assert.equal(observed.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(observed.request.redirect, 'error');
  assert.equal(observed.request.headers.Authorization, `Bearer ${env.MODEL_API_KEY}`);
  const body = JSON.parse(observed.request.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 650);
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
  assert.deepEqual(result.usage, { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 });
});

test('immutable melody locking cannot be overridden or omitted by the model', async () => {
  for (const changed of [{ ...plan, lockMelody: false }, { scope: 'all', operations: [{ type: 'softer' }] }]) {
    const result = await planMusicEdit(input, env, { fetchImpl: mockFetch({ status: 'ready', plan: changed }) });
    assert.equal(result.status, 'clarify');
    assert.equal(result.plan, undefined);
    assert.match(result.message, /锁定/);
  }
  const result = await planMusicEdit({ ...input, lockMelody: false }, env, { fetchImpl: mockFetch({ status: 'ready', plan }) });
  assert.equal(result.status, 'clarify');
});

test('scope selection cannot expand or shift silently, and inferred scope needs textual evidence', async () => {
  for (const request of [{ ...input, scope: 'firstHalf' }, { ...input, text: '伴奏留点呼吸' }]) {
    const result = await planMusicEdit(request, env, { fetchImpl: mockFetch({ status: 'ready', plan }) });
    assert.equal(result.status, 'clarify');
    assert.equal(result.plan, undefined);
    assert.match(result.message, /范围/);
  }
  const result = await planMusicEdit({ ...input, scope: 'secondHalf' }, env, {
    fetchImpl: mockFetch({ status: 'ready', plan: { ...plan, scope: 'all' } }),
  });
  assert.equal(result.status, 'clarify');
  const globalBypass = await planMusicEdit({ ...input, text: '后半段慢一点' }, env, {
    fetchImpl: mockFetch({ status: 'ready', plan: { ...plan, scope: 'all', operations: [{ type: 'slower', amount: 0.85 }] } }),
  });
  assert.equal(globalBypass.status, 'clarify');
  assert.equal(globalBypass.plan, undefined);
});

test('extra operations, invalid strengths, scripts and local global-only actions are rejected', async () => {
  for (const operations of [
    [{ type: 'addDrums' }], [{ type: 'softer', amount: 0 }], [{ type: 'softer', code: 'eval(secret)' }],
    [{ type: 'slower', amount: 0.8 }], [{ type: 'airy', preset: 'ice' }],
    [{ type: 'brighter', amount: 12 }], [{ type: 'softer' }, { type: 'softer' }],
  ]) {
    const result = await planMusicEdit(input, env, { fetchImpl: mockFetch({ status: 'ready', plan: { ...plan, operations } }) });
    assert.equal(result.status, 'clarify');
    assert.equal(result.plan, undefined);
  }
});

test('model prose and unknown response fields are never echoed as factual claims', async () => {
  const malicious = 'I listened to your audio; test-secret-do-not-return';
  for (const result of [
    { status: 'ready', plan, summary: malicious },
    { status: 'clarify', reason: 'ambiguous', message: malicious },
    { status: 'ready', plan: { ...plan, script: malicious } },
  ]) {
    const response = await planMusicEdit(input, env, { fetchImpl: mockFetch(result) });
    assert.notEqual(response.status, 'ready');
    assert.equal(JSON.stringify(response).includes(malicious), false);
  }
});

test('safe clarification/unsupported reasons survive, with graceful unknown-reason guidance', async () => {
  for (const status of ['clarify', 'unsupported']) {
    for (const reason of ['global-only', 'unsupported-feature', 'something-new-from-model']) {
      const result = await planMusicEdit(input, env, { fetchImpl: mockFetch({ status, reason }) });
      assert.equal(result.status, status);
      assert.equal(result.plan, undefined);
      assert.equal(result.message.includes('something-new'), false);
    }
  }
});

test('malformed, empty, oversized and truncated completions never produce edits', async () => {
  for (const content of ['', 'not json', '```json\n{}\n```', '[]', 'null', 'x'.repeat(33_000)]) {
    const result = await planMusicEdit(input, env, { fetchImpl: mockFetch(content) });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.plan, undefined);
  }
  const truncated = await planMusicEdit(input, env, { fetchImpl: mockFetch({ status: 'ready', plan }, { finish: 'length' }) });
  assert.equal(truncated.status, 'clarify');
  assert.equal(truncated.plan, undefined);
});

test('input and credential/endpoint configuration are checked before contacting a model', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('should not reach network'); };
  for (const request of [null, {}, { ...input, text: '字'.repeat(181) }, { ...input, scope: 'secret' }, { ...input, tempo: NaN }, { ...input, bars: 200 }, { ...input, lockMelody: 1 }]) {
    assert.equal((await planMusicEdit(request, env, { fetchImpl })).status, 'unsupported');
  }
  for (const config of [{}, { ...env, MODEL_ENDPOINT: 'https://untrusted.example/' }, { ...env, MODEL_NAME: 'bad\nmodel' }, { MODEL_API_KEY: 'bad\nheader' }]) {
    assert.equal((await planMusicEdit(input, config, { fetchImpl })).status, 'unsupported');
  }
  assert.equal(requests, 0);
});

test('network/provider errors are sanitized and usage exposes only bounded numeric counters', async () => {
  for (const status of [401, 429, 500]) {
    const result = await planMusicEdit(input, env, { fetchImpl: mockFetch({ secret: env.MODEL_API_KEY }, { status }) });
    assert.equal(result.status, 'unsupported');
    assert.equal(JSON.stringify(result).includes(env.MODEL_API_KEY), false);
  }
  const failure = await planMusicEdit(input, env, { fetchImpl: async () => { throw new Error(env.MODEL_API_KEY); } });
  assert.equal(failure.message.includes(env.MODEL_API_KEY), false);
  const result = await planMusicEdit(input, env, { fetchImpl: mockFetch({ status: 'ready', plan }, {
    usage: { prompt_tokens: -1, completion_tokens: '100', total_tokens: 80, secret: env.MODEL_API_KEY },
  }) });
  assert.deepEqual(result.usage, { total_tokens: 80 });
});

test('15-second deadline aborts even a fetch implementation that ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = planMusicEdit(input, env, { fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  t.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'unsupported');
  assert.match(result.message, /超时/);
});

test('tempo summary reflects the actual clamped executor result and discloses timing effects', async () => {
  const result = await planMusicEdit({ ...input, text: '慢一点', tempo: 50 }, env, {
    fetchImpl: mockFetch({ status: 'ready', plan: { ...plan, scope: 'all', operations: [{ type: 'slower', amount: 0.85 }] } }),
  });
  assert.equal(result.status, 'ready');
  assert.match(result.summary, /50 → 50 BPM/);
  assert.match(result.summary, /播放时长/);
});
