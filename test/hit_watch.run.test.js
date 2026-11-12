/**
 * hit_watch.js 전체 흐름 테스트 — 노션·디스코드를 가짜로 바꿔 끼워 run()을 끝까지 돌린다.
 * (실행: node --test test/*.test.js)  네트워크를 쓰지 않고, 숫자는 모두 지어낸 값이다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const hw = require('../hit_watch.js');

const HOUR = 3600e3;
const DAY = 86400e3;
const NOW = Date.parse('2026-03-21T09:30:00Z');
const BRAND = 'brand-db';
const HIT = 'hit-db';
const ACCOUNT = 'account-db';
const HOOK = 'https://discord.test/api/webhooks/1/secret';

Object.assign(hw.CONFIG, {
  NOTION_TOKEN: 'test-token', BRAND_DB_ID: BRAND, HIT_DB_ID: HIT, ACCOUNT_DB_ID: ACCOUNT,
  DISCORD_WEBHOOK_URL: HOOK, WRITE_DELAY_MS: 0, DISCORD_RETRY_MS: 0,
});

// 로그는 테스트 출력에서 숨긴다
const quiet = async (fn) => {
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = error; }
};

/* 노션에 쓴 모양(text.content)을 읽는 모양(plain_text)으로 */
const readable = (props) => {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v.title) out[k] = { title: v.title.map((t) => ({ plain_text: t.text.content })) };
    else if (v.rich_text) out[k] = { rich_text: v.rich_text.map((t) => ({ plain_text: t.text.content })) };
    else out[k] = v;
  }
  return out;
};

const brandPage = ({ igId, hoursAgo, reach, shares = 0, saves = 0, watch = 8, collectedHoursAgo = 0.5, name = '테스트 릴스', code }) => ({
  id: `brand-${igId}`,
  properties: {
    '이름': { title: [{ plain_text: name }] },
    'Instagram ID': { rich_text: [{ plain_text: igId }] },
    '날짜': { date: { start: new Date(NOW - hoursAgo * HOUR).toISOString() } },
    '마지막 수집일': { date: { start: new Date(NOW - collectedHoursAgo * HOUR).toISOString() } },
    '도달': { number: reach }, '공유': { number: shares }, '저장': { number: saves },
    '평균 시청 시간(초)': { number: watch },
    '원본 URL': { url: `https://www.instagram.com/reel/${code || `C${igId}`}/` },
    '상품/브랜드': { multi_select: [{ name: '브랜드A' }] },
  },
});

// 기준이 되는 지난 릴스 4개 → 중앙값 23,000
const BASE = [5, 10, 15, 20].map((d, i) => brandPage({ igId: `base${i}`, hoursAgo: d * 24 + 3, reach: 20000 + i * 2000 }));

const hitRowPage = ({ igId, code, verdict = '평소', alert = '대상 아님', baseline = 23000, hoursAgo, lift = null, reach7 = null }) => ({
  id: `row-${igId || code}`,
  properties: {
    'Instagram ID': { rich_text: igId ? [{ plain_text: igId }] : [] },
    '링크': { url: `https://www.instagram.com/reel/${code || `C${igId}`}/` },
    '게시일': { date: { start: new Date(NOW - hoursAgo * HOUR).toISOString() } },
    '판정': { select: { name: verdict } },
    '알림': { select: { name: alert } },
    '통과한 기준': { multi_select: [] },
    '기준 중앙값': { number: baseline },
    '3일 팔로워 증감': { number: lift },
    '7일 도달': { number: reach7 },
    '메모': { rich_text: [] },
  },
});

const snapPage = (date, followers) => ({
  id: `snap-${date}`,
  properties: { '날짜': { date: { start: date } }, '팔로워 수': { number: followers }, '유형': { select: { name: '일일' } } },
});

function world({ reels = [], hitRows = [], snapshots = [], hitDbStatus = 200, hookStatus = () => 204, failWrites = false } = {}) {
  const calls = { created: [], patched: [], discord: [], brandFilter: null, hitFilter: null, auth: new Set() };
  const store = { hitRows: [...hitRows] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchStub = async (url, opts = {}) => {
    url = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url === HOOK) { calls.discord.push(body.content); return res(hookStatus(calls.discord.length), {}); }
    const ep = url.match(/^https:\/\/api\.notion\.com\/v1\/(.+)$/)?.[1];
    if (!ep) throw new Error(`예상하지 못한 주소: ${url}`);
    calls.auth.add(opts.headers.Authorization);
    if (ep === `databases/${BRAND}/query`) { calls.brandFilter = body.filter; return res(200, { object: 'list', results: reels, has_more: false }); }
    if (ep === `databases/${HIT}/query`) {
      calls.hitFilter = body.filter;
      if (hitDbStatus !== 200) return res(hitDbStatus, { object: 'error', message: 'Could not find database' });
      return res(200, { object: 'list', results: store.hitRows, has_more: false });
    }
    if (ep === `databases/${ACCOUNT}/query`) return res(200, { object: 'list', results: snapshots, has_more: false });
    if (failWrites && (opts.method === 'POST' || opts.method === 'PATCH') && ep.startsWith('pages')) {
      return res(400, { object: 'error', message: 'validation_error' });
    }
    if (ep === 'pages' && opts.method === 'POST') {
      assert.equal(body.parent.database_id, HIT);
      const page = { object: 'page', id: `row-new-${store.hitRows.length + 1}`, properties: readable(body.properties) };
      store.hitRows.push(page); calls.created.push(body.properties);
      return res(200, page);
    }
    if (ep.startsWith('pages/') && opts.method === 'PATCH') {
      const page = store.hitRows.find((p) => p.id === ep.slice(6));
      assert.ok(page, '없는 행을 고치려 함');
      Object.assign(page.properties, readable(body.properties));
      calls.patched.push({ id: page.id, properties: body.properties });
      return res(200, page);
    }
    throw new Error(`예상하지 못한 요청: ${opts.method} ${ep}`);
  };
  return { calls, store, fetchStub };
}

async function runWith(w, opts = {}) {
  const real = global.fetch;
  global.fetch = w.fetchStub;
  try { return await quiet(() => hw.run({ now: NOW, dryRun: false, ...opts })); } finally { global.fetch = real; }
}

test('게시 22시간째 도달이 평소의 2.6배 → 히트 행을 만들고 디스코드로 한 번 알린다', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'hot', hoursAgo: 22, reach: 60000, shares: 120, saves: 300, watch: 13 })] });
  const stats = await runWith(w);
  assert.equal(w.calls.created.length, 1);
  const p = w.calls.created[0];
  assert.equal(p['판정'].select.name, '히트');
  assert.equal(p['알림'].select.name, '실패'); // 보내기 전에는 '실패'로 적어 두고
  assert.equal(w.store.hitRows.at(-1).properties['알림'].select.name, '보냄'); // 보낸 뒤 '보냄'으로 바꾼다
  assert.equal(p['평소 대비 배수'].number, 2.6);
  assert.equal(p['기준 중앙값'].number, 23000);
  assert.equal(p['판정 시점(시간)'].number, 22); // 수집 시점(30분 전) 기준 21.5시간
  assert.equal(p['공유/도달 %'].number, 0.2);
  assert.equal(p['저장/도달 %'].number, 0.5);
  assert.deepEqual(p['통과한 기준'].multi_select.map((o) => o.name), ['도달 2배', '평균 시청 12초']);
  assert.equal(p['Instagram ID'].rich_text[0].text.content, 'hot');
  assert.equal(p['링크'].url, 'https://www.instagram.com/reel/Chot/');
  assert.equal(p['상품/브랜드'].rich_text[0].text.content, '브랜드A');
  assert.equal(w.calls.discord.length, 1);
  assert.match(w.calls.discord[0], /평소 릴스의 2\.6배/);
  assert.deepEqual(stats, { judged: 1, hits: 1, late: 0, alerts: 1, lift: 0, seven: 0, errors: 0 });
  // 읽을 때 릴스만, 최근 기간만 조회한다
  assert.deepEqual(w.calls.brandFilter.and[0], { property: '채널', select: { equals: '릴스' } });
  assert.equal(w.calls.brandFilter.and[1].property, '날짜');
  assert.equal(w.calls.hitFilter.property, '게시일');
  assert.deepEqual([...w.calls.auth], ['Bearer test-token']);

  // 다음 실행: 이미 행이 있으므로 또 만들거나 또 알리지 않는다
  const patchedBefore = w.calls.patched.length;
  const again = await runWith(w);
  assert.equal(w.calls.created.length, 1);
  assert.equal(w.calls.discord.length, 1);
  assert.equal(w.calls.patched.length, patchedBefore);
  assert.equal(again.judged, 0);
});

test('게시 10시간째 평소 수준이면 아직 판정하지 않고, 22시간째 평소 수준이면 평소로 기록(알림 없음)', async () => {
  const young = world({ reels: [...BASE, brandPage({ igId: 'young', hoursAgo: 10, reach: 30000 })] });
  await runWith(young);
  assert.equal(young.calls.created.length, 0);

  const normal = world({ reels: [...BASE, brandPage({ igId: 'normal', hoursAgo: 22, reach: 25000, shares: 20 })] });
  await runWith(normal);
  assert.equal(normal.calls.created[0]['판정'].select.name, '평소');
  assert.equal(normal.calls.created[0]['알림'].select.name, '대상 아님');
  assert.equal(normal.calls.discord.length, 0);
});

test('게시 6시간째인데 도달이 이미 2배 → 기다리지 않고 미리 히트', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'early', hoursAgo: 6, reach: 50000 })] });
  await runWith(w);
  assert.equal(w.calls.created[0]['판정'].select.name, '히트');
  assert.match(w.calls.created[0]['메모'].rich_text[0].text.content, /미리 판정/);
  assert.equal(w.calls.discord.length, 1);
});

test('공유가 도달의 0.6% 이상이면 도달이 평소여도 히트 (20시간 뒤에만)', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'shared', hoursAgo: 23, reach: 24000, shares: 200 })] });
  await runWith(w);
  assert.equal(w.calls.created[0]['판정'].select.name, '히트');
  assert.deepEqual(w.calls.created[0]['통과한 기준'].multi_select.map((o) => o.name), ['공유 0.6%']);
});

test('인사이트가 아직 0이면 건너뛰고, 96시간이 지난 릴스는 새로 판정하지 않는다', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'zero', hoursAgo: 22, reach: 0 }), brandPage({ igId: 'old', hoursAgo: 100, reach: 90000 })] });
  await runWith(w);
  assert.equal(w.calls.created.length, 0);
});

test('수집이 멈춰 있으면 마지막 수집 시점의 나이로 본다 (게시 30시간이어도 수치가 8시간째 값이면 대기)', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'stale', hoursAgo: 30, collectedHoursAgo: 22, reach: 25000 })] });
  await runWith(w);
  assert.equal(w.calls.created.length, 0);
});

test('히트를 게시 48시간 뒤에야 처음 봤으면 행은 만들되 알림은 보내지 않는다', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'lateseen', hoursAgo: 60, reach: 70000 })] });
  await runWith(w);
  assert.equal(w.calls.created[0]['판정'].select.name, '히트');
  assert.equal(w.calls.created[0]['알림'].select.name, '대상 아님');
  assert.equal(w.calls.discord.length, 0);
});

test('웹후크가 없으면 노션에만 기록한다', async () => {
  hw.CONFIG.DISCORD_WEBHOOK_URL = undefined;
  try {
    const w = world({ reels: [...BASE, brandPage({ igId: 'nohook', hoursAgo: 22, reach: 60000 })] });
    await runWith(w);
    assert.equal(w.calls.created[0]['알림'].select.name, '웹후크 없음');
    assert.equal(w.calls.discord.length, 0);
  } finally { hw.CONFIG.DISCORD_WEBHOOK_URL = HOOK; }
});

test('디스코드 전송이 실패하면 실패로 적고, 다음 실행에서 다시 보낸다', async () => {
  let failing = true;
  const w = world({
    reels: [...BASE, brandPage({ igId: 'retry', hoursAgo: 22, reach: 60000 })],
    hookStatus: () => (failing ? 500 : 204),
  });
  await runWith(w);
  assert.equal(w.calls.created[0]['알림'].select.name, '실패');
  assert.equal(w.calls.discord.length, 2); // 두 번 시도
  failing = false;
  await runWith(w);
  assert.equal(w.calls.discord.length, 3);
  assert.equal(w.calls.patched.at(-1).properties['알림'].select.name, '보냄');
});

test("'평소'였던 릴스가 70시간째에 2배를 넘으면 히트로 바꾸고 알린다", async () => {
  const w = world({
    reels: [...BASE, brandPage({ igId: 'slow', hoursAgo: 70, reach: 50000, shares: 40 })],
    hitRows: [hitRowPage({ igId: 'slow', hoursAgo: 70 })],
  });
  const stats = await runWith(w);
  assert.equal(w.calls.created.length, 0);
  const patch = w.calls.patched[0].properties; // 판정을 먼저 적고
  assert.equal(patch['판정'].select.name, '히트');
  assert.deepEqual(patch['통과한 기준'].multi_select.map((o) => o.name), ['뒤늦은 도달 2배']);
  assert.equal(patch['평소 대비 배수'].number, 2.2);
  assert.match(patch['메모'].rich_text[0].text.content, /70시간째에 2배를 넘음/);
  assert.match(w.calls.discord[0], /^🔥 릴스가 뒤늦게 올라오고 있어요/); // 그다음 알린다
  const row = w.store.hitRows.find((r) => r.id === 'row-slow').properties;
  assert.equal(row['판정'].select.name, '히트');
  assert.equal(row['알림'].select.name, '보냄');
  assert.equal(stats.late, 1);
  // 다음 실행에서 같은 알림을 또 보내지 않는다
  await runWith(w);
  assert.equal(w.calls.discord.length, 1);
});

test('아침 작업이 링크만 넣어 만든 행도 같은 릴스로 알아본다 (Instagram ID 없음)', async () => {
  const w = world({
    reels: [...BASE, brandPage({ igId: 'manual', hoursAgo: 30, reach: 60000, code: 'DManual_1' })],
    hitRows: [hitRowPage({ code: 'DManual_1', verdict: '히트', alert: '아침 보고', hoursAgo: 30 })],
  });
  await runWith(w);
  assert.equal(w.calls.created.length, 0);
  assert.equal(w.calls.discord.length, 0);
});

test('게시 5일 뒤 3일 팔로워 증감을, 8일 뒤 7일 도달을 채운다', async () => {
  // 팔로워: 게시(5일 전) 이전에는 매일 -20, 이후 3일 동안 +500
  const postDate = hw.kstDate(NOW - 5 * DAY);
  const snaps = [];
  for (let i = -15; i <= -1; i++) snaps.push(snapPage(hw.addDays(postDate, i), 50000 + (i + 15) * -20));
  snaps.push(snapPage(postDate, 49850), snapPage(hw.addDays(postDate, 1), 50100), snapPage(hw.addDays(postDate, 2), 50180), snapPage(hw.addDays(postDate, 3), 50220));
  const w = world({
    reels: [...BASE,
      brandPage({ igId: 'five', hoursAgo: 5 * 24, reach: 100000 }),
      brandPage({ igId: 'eight', hoursAgo: 8 * 24, reach: 46000 })],
    hitRows: [
      hitRowPage({ igId: 'five', verdict: '히트', alert: '보냄', hoursAgo: 5 * 24 }),
      hitRowPage({ igId: 'eight', verdict: '평소', hoursAgo: 8 * 24, lift: -12 })],
    snapshots: snaps,
  });
  const stats = await runWith(w);
  const five = w.calls.patched.find((p) => p.id === 'row-five').properties;
  // 시작 = 게시 전날(49,720), 끝 = 게시 3일 뒤(50,220), 4일 → +500, 평소 -20/일 → 추가 580
  assert.equal(five['3일 팔로워 증감'].number, 500);
  assert.equal(five['평소 대비 추가 팔로워'].number, 580);
  assert.equal(five['팔로우 전환 %'].number, 0.58);
  assert.equal(five['7일 도달'], undefined);
  assert.doesNotMatch(five['메모'].rich_text[0].text.content, /겹/);
  const eight = w.calls.patched.find((p) => p.id === 'row-eight').properties;
  assert.equal(eight['7일 도달'].number, 46000);
  assert.equal(eight['7일 배수'].number, 2);
  assert.equal(eight['판정'], undefined); // 7일이 지나면 뒤늦은 히트로 바꾸지 않는다
  assert.equal(stats.lift, 1);
  assert.equal(stats.seven, 1);
  assert.equal(w.calls.discord.length, 0);
});

test('히트끼리 기간이 겹치면 전환율은 비우고, 평소 릴스에는 전환율을 적지 않는다', async () => {
  const postDate = hw.kstDate(NOW - 6 * DAY);
  const snaps = [];
  for (let i = -15; i <= 6; i++) snaps.push(snapPage(hw.addDays(postDate, i), 50000 + (i < 0 ? (i + 15) * -20 : -280 + i * 150)));
  const w = world({
    reels: [...BASE,
      brandPage({ igId: 'hitA', hoursAgo: 6 * 24, reach: 100000 }),
      brandPage({ igId: 'hitB', hoursAgo: 5 * 24, reach: 80000 }),
      brandPage({ igId: 'plain', hoursAgo: 4 * 24 + 2, reach: 21000 })],
    hitRows: [
      hitRowPage({ igId: 'hitA', verdict: '히트', alert: '보냄', hoursAgo: 6 * 24 }),
      hitRowPage({ igId: 'hitB', verdict: '히트', alert: '보냄', hoursAgo: 5 * 24 }),
      hitRowPage({ igId: 'plain', verdict: '평소', hoursAgo: 4 * 24 + 2 })],
    snapshots: snaps,
  });
  await runWith(w);
  const a = w.calls.patched.find((p) => p.id === 'row-hitA').properties;
  assert.ok(a['평소 대비 추가 팔로워'].number > 0);
  assert.equal(a['팔로우 전환 %'], undefined);
  assert.match(a['메모'].rich_text[0].text.content, /다른 히트 1개와 기간이 겹쳐/);
  const plain = w.calls.patched.find((p) => p.id === 'row-plain').properties;
  assert.equal(plain['팔로우 전환 %'], undefined);
  assert.match(plain['메모'].rich_text[0].text.content, /히트 2개와 기간이 겹침/);
});

test('행을 만들지 못하면 알림도 보내지 않는다 (같은 알림이 실행마다 되풀이되는 일 방지)', async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'hot', hoursAgo: 22, reach: 60000 })], failWrites: true });
  const stats = await runWith(w);
  assert.equal(w.calls.discord.length, 0);
  assert.equal(stats.errors, 1);
  assert.equal(stats.judged, 0);

  const late = world({
    reels: [...BASE, brandPage({ igId: 'slow', hoursAgo: 70, reach: 50000 })],
    hitRows: [hitRowPage({ igId: 'slow', hoursAgo: 70 })],
    failWrites: true,
  });
  const lateStats = await runWith(late);
  assert.equal(late.calls.discord.length, 0);
  assert.equal(lateStats.errors, 1);
});

test("'히트 판정' DB를 못 읽으면 아무것도 쓰지 않고 이유를 알리며 멈춘다", async () => {
  const w = world({ reels: [...BASE, brandPage({ igId: 'hot', hoursAgo: 22, reach: 60000 })], hitDbStatus: 404 });
  await assert.rejects(() => runWith(w), /히트 판정/);
  assert.equal(w.calls.created.length, 0);
  assert.equal(w.calls.discord.length, 0);
});

test('DRY RUN이면 노션에도 디스코드에도 쓰지 않는다', async () => {
  const w = world({
    reels: [...BASE, brandPage({ igId: 'hot', hoursAgo: 22, reach: 60000 }), brandPage({ igId: 'slow', hoursAgo: 70, reach: 50000 })],
    hitRows: [hitRowPage({ igId: 'slow', hoursAgo: 70 })],
  });
  await runWith(w, { dryRun: true });
  assert.equal(w.calls.created.length, 0);
  assert.equal(w.calls.patched.length, 0);
  assert.equal(w.calls.discord.length, 0);
});

test('토큰이 없으면 바로 멈춘다', async () => {
  hw.CONFIG.NOTION_TOKEN = '';
  try { await assert.rejects(() => hw.run({ now: NOW }), /필수 환경 변수/); } finally { hw.CONFIG.NOTION_TOKEN = 'test-token'; }
});
