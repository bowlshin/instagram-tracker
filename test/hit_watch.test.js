/**
 * hit_watch.js 판정 규칙 테스트 (실행: node --test test/hit_watch.test.js)
 * 숫자는 모두 지어낸 값이다. 실제 계정 수치는 이 공개 저장소에 올리지 않는다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const hw = require('../hit_watch.js');

const DAY = 86400e3;
const HOUR = 3600e3;
const T0 = Date.parse('2026-03-20T11:00:00Z'); // 판정 대상 릴스의 게시 시각 (KST 3/20 20:00)

const reel = (daysBefore, reach, extra = {}) => ({
  igId: `id-${daysBefore}-${reach}`,
  name: '테스트 릴스',
  postedAt: T0 - daysBefore * DAY,
  reach, shares: 0, saves: 0, avgWatch: 8, link: '', ...extra,
});

test('median: 홀수·짝수·빈 배열', () => {
  assert.equal(hw.median([3, 1, 2]), 2);
  assert.equal(hw.median([4, 1, 3, 2]), 2.5);
  assert.equal(hw.median([]), null);
});

test('baselineFor: 게시 전 30일 릴스 4개 이상이면 그 중앙값', () => {
  const target = reel(0, 50000);
  const reels = [target, reel(3, 10000), reel(10, 20000), reel(20, 30000), reel(29, 40000), reel(45, 900000)];
  const b = hw.baselineFor(target, reels);
  assert.deepEqual(b, { median: 25000, count: 4, days: 30 });
});

test('baselineFor: 30일에 4개가 안 되면 60일, 90일로 넓힌다', () => {
  const target = reel(0, 50000);
  const reels = [target, reel(5, 10000), reel(40, 20000), reel(50, 30000), reel(55, 40000)];
  assert.equal(hw.baselineFor(target, reels).days, 60);
  const sparse = [target, reel(5, 10000), reel(40, 20000), reel(70, 30000), reel(85, 40000)];
  assert.equal(hw.baselineFor(target, sparse).days, 90);
});

test('baselineFor: 도달 1,000 미만(노출 이상)과 이후에 올린 릴스는 뺀다', () => {
  const target = reel(0, 50000);
  const later = reel(-2, 999999); // 대상보다 나중에 올린 릴스
  const reels = [target, later, reel(1, 61), reel(3, 10000), reel(10, 20000), reel(20, 30000), reel(29, 40000)];
  const b = hw.baselineFor(target, reels);
  assert.equal(b.count, 4);
  assert.equal(b.median, 25000);
});

test('baselineFor: 90일까지 넓혀도 4개 미만이면 null', () => {
  const target = reel(0, 50000);
  assert.equal(hw.baselineFor(target, [target, reel(5, 10000), reel(40, 20000)]), null);
});

test('evaluate: 도달이 기준의 2배 이상이면 히트', () => {
  const ev = hw.evaluate(reel(0, 50000, { shares: 10 }), { median: 25000 });
  assert.equal(ev.multiple, 2);
  assert.deepEqual(ev.passed, [hw.PASS.REACH]);
  assert.equal(ev.hit, true);
});

test('evaluate: 공유가 도달의 0.6% 이상이면 히트 (도달 3,000 이상일 때만)', () => {
  const big = hw.evaluate(reel(0, 30000, { shares: 180 }), { median: 25000 });
  assert.deepEqual(big.passed, [hw.PASS.SHARE]);
  assert.equal(big.hit, true);
  const tiny = hw.evaluate(reel(0, 2000, { shares: 40 }), { median: 25000 });
  assert.equal(tiny.hit, false);
});

test('evaluate: 평균 시청 12초만 넘으면 기록은 하지만 히트는 아니다', () => {
  const ev = hw.evaluate(reel(0, 30000, { shares: 30, avgWatch: 13 }), { median: 25000 });
  assert.deepEqual(ev.passed, [hw.PASS.WATCH]);
  assert.equal(ev.hit, false);
});

test('evaluate: 기준이 없으면 배수는 null이고 공유 비율로만 판정', () => {
  const ev = hw.evaluate(reel(0, 30000, { shares: 300 }), null);
  assert.equal(ev.multiple, null);
  assert.equal(ev.hit, true);
});

test('planNew: 20시간 전에는 도달 2배를 넘은 경우만 미리 히트', () => {
  const reachHit = hw.evaluate(reel(0, 60000), { median: 25000 });
  const shareOnly = hw.evaluate(reel(0, 30000, { shares: 300 }), { median: 25000 });
  const normal = hw.evaluate(reel(0, 20000), { median: 25000 });
  assert.deepEqual(hw.planNew(10, reachHit), { verdict: hw.VERDICT.HIT, early: true });
  assert.equal(hw.planNew(10, shareOnly), null);
  assert.equal(hw.planNew(10, normal), null);
  assert.equal(hw.planNew(1, reachHit), null); // 너무 이름
});

test('planNew: 20시간이 지나면 히트/평소를 확정하고, 96시간이 지난 릴스는 새로 판정하지 않는다', () => {
  const shareOnly = hw.evaluate(reel(0, 30000, { shares: 300 }), { median: 25000 });
  const normal = hw.evaluate(reel(0, 20000), { median: 25000 });
  assert.deepEqual(hw.planNew(22, shareOnly), { verdict: hw.VERDICT.HIT, early: false });
  assert.deepEqual(hw.planNew(22, normal), { verdict: hw.VERDICT.NORMAL, early: false });
  assert.equal(hw.planNew(100, normal), null);
});

test('isLateHit: 평소였던 릴스가 7일 안에 2배를 넘으면 뒤늦은 히트', () => {
  const row = { verdict: hw.VERDICT.NORMAL, baselineMedian: 25000 };
  assert.equal(hw.isLateHit(row, reel(0, 52000), 70), true);
  assert.equal(hw.isLateHit(row, reel(0, 40000), 70), false);
  assert.equal(hw.isLateHit(row, reel(0, 52000), 200), false); // 7일 지남
  assert.equal(hw.isLateHit({ verdict: hw.VERDICT.HIT, baselineMedian: 25000 }, reel(0, 52000), 70), false);
  assert.equal(hw.isLateHit({ verdict: hw.VERDICT.NORMAL, baselineMedian: null }, reel(0, 52000), 70), false);
});

// 팔로워 기록: 3/5 ~ 3/19 매일 -20, 게시(3/20) 뒤 급증
const snaps = () => {
  const out = [];
  let f = 50000;
  for (let i = 0; i <= 14; i++) { out.push({ date: hw.addDays('2026-03-05', i), followers: f }); f -= 20; }
  // out 마지막 = 3/19: 49720
  out.push({ date: '2026-03-20', followers: 49800 });
  out.push({ date: '2026-03-21', followers: 50050 });
  out.push({ date: '2026-03-22', followers: 50120 });
  out.push({ date: '2026-03-23', followers: 50140 });
  return out;
};

test('followerLift: 게시 전날 → 3일 뒤 변화에서 평소 하루 증감을 뺀다', () => {
  const lift = hw.followerLift(T0, snaps(), '2026-03-25');
  assert.equal(lift.startDate, '2026-03-19');
  assert.equal(lift.endDate, '2026-03-23');
  assert.equal(lift.days, 4);
  assert.equal(lift.raw, 50140 - 49720);
  assert.equal(lift.dailyBaseline, -20);
  assert.equal(lift.extra, 420 + 80);
});

test('followerLift: 끝 날짜 기록이 아직 없거나 오늘 것이면 null (다음 실행에서 다시)', () => {
  const partial = snaps().filter((s) => s.date <= '2026-03-22');
  assert.equal(hw.followerLift(T0, partial, '2026-03-24'), null);
  assert.equal(hw.followerLift(T0, snaps(), '2026-03-23'), null); // 3/23 행은 아직 갱신 중
});

test('followerLift: 빠진 날짜가 있으면 가장 가까운 이전·이후 기록을 쓰고 일수를 맞춘다', () => {
  const gappy = snaps().filter((s) => s.date !== '2026-03-19' && s.date !== '2026-03-23');
  gappy.push({ date: '2026-03-24', followers: 50130 });
  const lift = hw.followerLift(T0, gappy, '2026-03-26');
  assert.equal(lift.startDate, '2026-03-18');
  assert.equal(lift.endDate, '2026-03-24');
  assert.equal(lift.days, 6);
  assert.equal(lift.raw, 50130 - 49740);
  assert.equal(lift.extra, 390 + 120);
});

test('followerLift: 게시 전 기록이 5일 미만이면 추가 팔로워는 비운다', () => {
  const short = snaps().filter((s) => s.date >= '2026-03-17');
  const lift = hw.followerLift(T0, short, '2026-03-25');
  assert.equal(lift.raw, 420);
  assert.equal(lift.extra, null);
});

test('buildDiscordMessage: 폰 알림용 문구', () => {
  const r = reel(0, 54000, { shares: 1200, avgWatch: 14, name: '캡션 첫 줄입니다\n둘째 줄', link: 'https://www.instagram.com/reel/ABC123/' });
  const ev = hw.evaluate(r, { median: 18000 });
  const msg = hw.buildDiscordMessage(r, ev, 14.2);
  const lines = msg.split('\n');
  assert.equal(lines[0], '🔥 릴스가 평소보다 잘 나가고 있어요');
  assert.equal(lines[1], '「캡션 첫 줄입니다」 · 올린 지 14시간');
  assert.equal(lines[2], '도달 5.4만 — 평소 릴스의 3.0배');
  assert.equal(lines[3], '공유 1,200회 — 도달의 2.22%');
  assert.equal(lines[4], '평균 시청 14초');
  assert.equal(lines.at(-1), 'https://www.instagram.com/reel/ABC123/');
  assert.ok(msg.length < 600);
  assert.match(hw.buildDiscordMessage(r, ev, 70, { late: true }), /^🔥 릴스가 뒤늦게 올라오고 있어요/);
});

test('날짜·표기 도우미', () => {
  assert.equal(hw.kstDate(Date.parse('2026-03-20T15:30:00Z')), '2026-03-21'); // KST로는 다음 날 00:30
  assert.equal(hw.dayDiff('2026-02-27', '2026-03-02'), 3);
  assert.equal(hw.reelCode('https://www.instagram.com/reel/DQx-9_abc/?utm=1'), 'DQx-9_abc');
  assert.equal(hw.fmtCount(8123), '8,123');
  assert.equal(hw.fmtCount(123456), '12.3만');
  assert.equal(hw.rowTitle(reel(0, 1, { name: '캡션 첫 줄입니다\n둘째 줄' })), '3/20 캡션 첫 줄입니다');
});

test('toReel / toHitRow: 노션 API 응답에서 필요한 칸을 읽는다', () => {
  const page = {
    id: 'page-1',
    properties: {
      '이름': { title: [{ plain_text: '캡션 첫 줄' }] },
      'Instagram ID': { rich_text: [{ plain_text: '17900000000000000' }] },
      '날짜': { date: { start: '2026-03-20T11:00:00.000+00:00' } },
      '마지막 수집일': { date: { start: '2026-03-21T09:05:00.000Z' } },
      '도달': { number: 12345 }, '공유': { number: 67 }, '저장': { number: 89 },
      '평균 시청 시간(초)': { number: 11 },
      '원본 URL': { url: 'https://www.instagram.com/reel/ABC123/' },
      '상품/브랜드': { multi_select: [{ name: '브랜드A' }, { name: '브랜드B' }] },
    },
  };
  const r = hw.toReel(page);
  assert.equal(r.igId, '17900000000000000');
  assert.equal(r.postedAt, T0);
  assert.equal(r.reach, 12345);
  assert.equal(r.product, '브랜드A · 브랜드B');
  assert.equal(Math.round((r.collectedAt - r.postedAt) / HOUR), 22);

  const row = hw.toHitRow({
    id: 'row-1',
    properties: {
      'Instagram ID': { rich_text: [{ plain_text: '17900000000000000' }] },
      '링크': { url: 'https://www.instagram.com/reel/ABC123/' },
      '판정': { select: { name: '평소' } },
      '알림': { select: { name: '아침 보고' } },
      '통과한 기준': { multi_select: [{ name: '평균 시청 12초' }] },
      '기준 중앙값': { number: 25000 },
      '3일 팔로워 증감': { number: null },
      '7일 도달': { number: null },
      '메모': { rich_text: [] },
    },
  });
  assert.equal(row.code, 'ABC123');
  assert.equal(row.verdict, hw.VERDICT.NORMAL);
  assert.equal(row.baselineMedian, 25000);
  assert.equal(row.lift, null);
});
