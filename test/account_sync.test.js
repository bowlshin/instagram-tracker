/**
 * ig-account-sync-v1.js 의 '팔로우 획득·이탈' 단계 테스트
 * (실행: node --test test/account_sync.test.js)  네트워크를 쓰지 않고, 숫자는 모두 지어낸 값이다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../ig-account-sync-v1.js');

Object.assign(sync.CONFIG, {
  NOTION_TOKEN: 'notion-test', INSTAGRAM_TOKEN: 'ig-test', INSTAGRAM_ACCOUNT_ID: '999',
  ACCOUNT_DB_ID: 'acct-db', CALL_DELAY_MS: 0,
});

const quiet = async (fn) => {
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = error; }
};

// Meta 문서의 total_value + breakdown 응답 모양
const igResponse = (results) => ({
  data: [{
    name: 'follows_and_unfollows', period: 'day', title: 't', description: 'd', id: '999/insights/follows_and_unfollows/day',
    total_value: { breakdowns: [{ dimension_keys: ['follow_type'], results }] },
  }],
});
const both = (gained, lost) => igResponse([
  { dimension_values: ['FOLLOWER'], value: gained },
  { dimension_values: ['NON_FOLLOWER'], value: lost },
]);

test('parseFollowBreakdown: FOLLOWER = 획득, NON_FOLLOWER = 이탈, 증감 = 획득 − 이탈', () => {
  assert.deepEqual(sync.parseFollowBreakdown(both(41, 37)), { gained: 41, lost: 37, net: 4, unknown: 0 });
  const withUnknown = igResponse([
    { dimension_values: ['NON_FOLLOWER'], value: 30 },
    { dimension_values: ['UNKNOWN'], value: 2 },
    { dimension_values: ['FOLLOWER'], value: 25 },
  ]);
  assert.deepEqual(sync.parseFollowBreakdown(withUnknown), { gained: 25, lost: 30, net: -5, unknown: 2 });
});

test('parseFollowBreakdown: 한쪽만 오면 다른 쪽은 0', () => {
  assert.deepEqual(sync.parseFollowBreakdown(igResponse([{ dimension_values: ['FOLLOWER'], value: 12 }])),
    { gained: 12, lost: 0, net: 12, unknown: 0 });
});

test('parseFollowBreakdown: 값이 없으면 0이 아니라 null (breakdown 없는 옛 응답, 빈 응답, UNKNOWN 뿐)', () => {
  // breakdown 없이 요청했을 때의 모양 — 이 때문에 0만 쌓였다
  assert.equal(sync.parseFollowBreakdown({ data: [{ name: 'follows_and_unfollows', total_value: { value: 0 } }] }), null);
  assert.equal(sync.parseFollowBreakdown({ data: [] }), null);
  assert.equal(sync.parseFollowBreakdown({}), null);
  assert.equal(sync.parseFollowBreakdown(igResponse([{ dimension_values: ['UNKNOWN'], value: 3 }])), null);
  assert.equal(sync.parseFollowBreakdown(igResponse([])), null);
});

test('kstDayRange / addDaysYmd: KST 하루 = 전날 15:00 UTC부터 24시간', () => {
  const { since, until } = sync.kstDayRange('2026-03-20');
  assert.equal(new Date(since * 1000).toISOString(), '2026-03-19T15:00:00.000Z');
  assert.equal(until - since, 86400);
  assert.equal(sync.addDaysYmd('2026-03-01', -1), '2026-02-28');
  assert.equal(sync.addDaysYmd('2026-12-31', 1), '2027-01-01');
});

const row = (date, hasFollows) => ({ pageId: `p-${date}`, date, hasFollows });

test('pickFollowTargets: 어제부터 3일은 값이 있어도 다시, 그 전은 빈 칸만 최신순으로 정해진 개수', () => {
  const rows = [
    row('2026-03-20', false), // 오늘 — 대상 아님
    row('2026-03-19', true), row('2026-03-18', true), /* 3/17 행 없음 */
    row('2026-03-16', false), row('2026-03-15', true), row('2026-03-14', false), row('2026-03-10', false),
    row('2026-01-01', false), // 45일보다 오래됨
  ];
  const cfg = { FOLLOW_FINALIZE_DAYS: 3, FOLLOW_BACKFILL_WINDOW_DAYS: 45, FOLLOW_BACKFILL_PER_RUN: 2 };
  const { finalize, backfill } = sync.pickFollowTargets(rows, '2026-03-20', cfg);
  assert.deepEqual(finalize.map((r) => r.date), ['2026-03-19', '2026-03-18']);
  assert.deepEqual(backfill.map((r) => r.date), ['2026-03-16', '2026-03-14']);
  const all = sync.pickFollowTargets(rows, '2026-03-20', { ...cfg, FOLLOW_BACKFILL_PER_RUN: 10 });
  assert.deepEqual(all.backfill.map((r) => r.date), ['2026-03-16', '2026-03-14', '2026-03-10']);
});

/* 가짜 인스타그램·노션 */
function world({ rows, igByDate, patchStatus = 200 }) {
  const calls = { ig: [], patched: [], notionFilter: null };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchStub = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://graph.facebook.com/')) {
      const u = new URL(url);
      assert.equal(u.pathname.endsWith('/999/insights'), true);
      assert.equal(u.searchParams.get('metric'), 'follows_and_unfollows');
      assert.equal(u.searchParams.get('metric_type'), 'total_value');
      assert.equal(u.searchParams.get('breakdown'), 'follow_type');
      assert.equal(u.searchParams.get('period'), 'day');
      assert.equal(Number(u.searchParams.get('until')) - Number(u.searchParams.get('since')), 86400);
      // since(전날 15:00 UTC) + 9시간 = 그 KST 날짜
      const date = new Date((Number(u.searchParams.get('since')) + 9 * 3600) * 1000).toISOString().slice(0, 10);
      calls.ig.push(date);
      const answer = igByDate[date];
      if (answer === 'throw') throw new TypeError('fetch failed');
      return res(200, answer || { data: [] });
    }
    const ep = url.match(/^https:\/\/api\.notion\.com\/v1\/(.+)$/)?.[1];
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (ep === 'databases/acct-db/query') {
      calls.notionFilter = body.filter;
      return res(200, { object: 'list', results: rows, has_more: false });
    }
    if (ep?.startsWith('pages/') && opts.method === 'PATCH') {
      if (patchStatus !== 200) return res(patchStatus, { object: 'error', message: '팔로우 획득 is not a property that exists.' });
      calls.patched.push({ id: ep.slice(6), properties: body.properties });
      return res(200, { object: 'page', id: ep.slice(6) });
    }
    throw new Error(`예상하지 못한 요청: ${opts.method || 'GET'} ${url.split('?')[0]}`);
  };
  return { calls, fetchStub };
}
const page = (date, gained = null) => ({
  id: `p-${date}`,
  properties: { '날짜': { date: { start: date } }, '유형': { select: { name: '일일' } }, '팔로우 획득': { number: gained } },
});
async function runWith(w, today) {
  const real = global.fetch;
  global.fetch = w.fetchStub;
  try { return await quiet(() => sync.processFollowBreakdown({ today })); } finally { global.fetch = real; }
}

test('processFollowBreakdown: 어제부터 3일을 다시 받아 그 날짜 행에 적고, 지난 빈 칸도 채운다', async () => {
  const w = world({
    rows: [page('2026-03-20'), page('2026-03-19', 5), page('2026-03-18', 7), page('2026-03-17'), page('2026-03-12'), page('2026-03-11', 9)],
    igByDate: {
      '2026-03-19': both(41, 37), '2026-03-18': both(120, 44), '2026-03-17': both(18, 39), '2026-03-12': both(22, 30),
    },
  });
  const out = await runWith(w, '2026-03-20');
  assert.deepEqual(w.calls.ig, ['2026-03-19', '2026-03-18', '2026-03-17', '2026-03-12']); // 오늘과 이미 채운 3/11은 부르지 않음
  assert.deepEqual(out, { targets: 4, updated: 4, failed: 0 });
  const byId = Object.fromEntries(w.calls.patched.map((p) => [p.id, p.properties]));
  assert.deepEqual(byId['p-2026-03-19'], { '팔로우 획득': { number: 41 }, '팔로우 이탈': { number: 37 }, '팔로우 증감': { number: 4 } });
  assert.deepEqual(byId['p-2026-03-18'], { '팔로우 획득': { number: 120 }, '팔로우 이탈': { number: 44 }, '팔로우 증감': { number: 76 } });
  assert.deepEqual(byId['p-2026-03-17']['팔로우 증감'], { number: -21 });
  assert.equal(byId['p-2026-03-20'], undefined);
  assert.deepEqual(w.calls.notionFilter.and[0], { property: '유형', select: { equals: '일일' } });
  assert.deepEqual(w.calls.notionFilter.and[1], { property: '날짜', date: { on_or_after: '2026-02-03' } });
});

test('processFollowBreakdown: 값이 없거나 요청이 실패한 날은 건너뛰고(0을 적지 않음) 나머지는 계속한다', async () => {
  const w = world({
    rows: [page('2026-03-19'), page('2026-03-18'), page('2026-03-17'), page('2026-03-16')],
    igByDate: {
      '2026-03-19': { data: [] },                                   // 아직 집계 전
      '2026-03-18': { error: { message: '(#100) 예시 오류', code: 100 } },
      '2026-03-17': 'throw',
      '2026-03-16': both(10, 20),
    },
  });
  const out = await runWith(w, '2026-03-20');
  assert.deepEqual(out, { targets: 4, updated: 1, failed: 3 });
  assert.deepEqual(w.calls.patched.map((p) => p.id), ['p-2026-03-16']);
});

test("processFollowBreakdown: 노션에 속성이 없으면(400) 첫 실패에서 멈추고 예외를 던지지 않는다", async () => {
  const w = world({
    rows: [page('2026-03-19'), page('2026-03-18'), page('2026-03-17')],
    igByDate: { '2026-03-19': both(1, 2), '2026-03-18': both(3, 4), '2026-03-17': both(5, 6) },
    patchStatus: 400,
  });
  const out = await runWith(w, '2026-03-20');
  assert.deepEqual(out, { targets: 3, updated: 0, failed: 1 });
  assert.deepEqual(w.calls.ig, ['2026-03-19']);
});
