/**
 * hit_watch.js — 우리 릴스 24시간 판정
 *
 * 흐름 (Instagram API는 부르지 않는다. 노션만 읽고 쓴다)
 *   노션 '브랜드 action'(collect_auto.js가 6시간마다 갱신)의 우리 릴스
 *   → 게시 20시간이 지난 릴스를 '히트 / 평소'로 판정해 노션 '히트 판정' DB에 1행
 *     (도달이 이미 평소의 2배를 넘었으면 20시간 전이라도 바로 히트)
 *   → 히트면 디스코드 웹후크로 알림 (DISCORD_WEBHOOK_URL 이 있을 때만)
 *   → '평소'였던 릴스가 7일 안에 뒤늦게 2배를 넘으면 히트로 바꾸고 알림
 *   → 게시 4일 뒤 '3일 팔로워 증감', 7일 뒤 '7일 도달'을 같은 행에 채움
 *     ('팔로우 전환 %'는 앞뒤 3일 안에 다른 히트가 없는 히트에만 — 겹치면 나눌 수 없어서)
 *
 * 판정 규칙 (출발값. 기록이 쌓이면 아래 RULES 숫자만 고치면 된다)
 *   기준 중앙값 = 그 릴스 게시 전 30일 우리 릴스 도달의 중앙값
 *                 (도달 1,000 미만 릴스 제외, 4개 미만이면 60 → 90일로 넓힘)
 *   히트 = 도달 ÷ 기준 중앙값 ≥ 2  또는  공유 ÷ 도달 ≥ 0.6% (도달 3,000 이상일 때)
 *   평균 시청 12초 이상은 '통과한 기준'에 기록만 한다 (혼자서는 히트가 아님)
 *
 * 필수 환경 변수: NOTION_TOKEN, NOTION_DB_ID (브랜드 action)
 * 선택: DISCORD_WEBHOOK_URL (없으면 알림 없이 노션에만 기록)
 *       HIT_DB_ID, NOTION_ACCOUNT_DB_ID (기본값 아래)
 *       DRY_RUN=1 (노션·디스코드에 쓰지 않고 로그만)
 *       VERBOSE=1 (로그에 숫자 포함 — 로컬 확인용)
 *
 * 이 저장소는 공개라서 Actions 로그도 공개된다. 기본 로그에는 도달·공유 같은 숫자와
 * 캡션을 찍지 않는다.
 *
 * 테스트: node --test test/hit_watch.test.js
 */

const CONFIG = {
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  BRAND_DB_ID: process.env.NOTION_DB_ID,
  // 2026-11-12 생성된 DB ID (환경 변수로 덮어쓰기 가능)
  HIT_DB_ID: process.env.HIT_DB_ID || '5130bcfc78aa407c8f0f8272cfdc6072',
  ACCOUNT_DB_ID: process.env.NOTION_ACCOUNT_DB_ID || '6a2d4561098d4fc6aab823977b72d7fb',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  WRITE_DELAY_MS: 350,      // 노션 쓰기 사이 간격
  DISCORD_RETRY_MS: 1500,   // 디스코드 재시도 전 대기
};

const RULES = {
  REACH_MULTIPLE: 2,          // 도달 ÷ 기준 중앙값
  SHARE_RATE_PCT: 0.6,        // 공유 ÷ 도달 (%)
  SHARE_MIN_REACH: 3000,      // 도달이 이보다 작으면 공유 비율은 판정에 쓰지 않음
  WATCH_SECONDS: 12,          // 기록만 하는 기준

  BASELINE_WINDOWS_DAYS: [30, 60, 90],
  BASELINE_MIN_REELS: 4,
  BASELINE_MIN_REACH: 1000,   // 노출 이상(도달 수십) 릴스는 기준에서 제외

  EARLY_HIT_AFTER_HOURS: 2,   // 이 시간부터 '도달 2배'면 미리 히트
  JUDGE_AFTER_HOURS: 20,      // 이 시간이 지나면 히트/평소를 확정
  CREATE_UNTIL_HOURS: 96,     // 이보다 오래된 릴스는 새로 판정하지 않음
  ALERT_UNTIL_HOURS: 48,      // 새 히트 알림은 게시 48시간 안에서만
  LATE_HIT_UNTIL_HOURS: 168,  // '평소' → 뒤늦은 히트로 바꾸는 한도

  LIFT_AFTER_HOURS: 96,       // 3일 팔로워 증감을 채우기 시작하는 시점
  LIFT_DAYS_AFTER: 3,
  LIFT_BASELINE_DAYS: 14,     // 평소 하루 증감을 재는 기간(게시 전)
  LIFT_BASELINE_MIN_DAYS: 5,
  SEVEN_DAY_HOURS: 168,

  LOOKBACK_DAYS: 100,         // 브랜드 action에서 읽어 올 기간 (기준 중앙값 90일 + 여유)
  HIT_ROWS_LOOKBACK_DAYS: 15, // 히트 판정 DB에서 다시 볼 기간
};

const VERDICT = { HIT: '히트', NORMAL: '평소' };
const PASS = { REACH: '도달 2배', SHARE: '공유 0.6%', WATCH: '평균 시청 12초', LATE: '뒤늦은 도달 2배' };
const ALERT = { SENT: '보냄', NO_WEBHOOK: '웹후크 없음', FAILED: '실패', NOT_TARGET: '대상 아님' };

const DRY_RUN = process.env.DRY_RUN === '1';
const VERBOSE = process.env.VERBOSE === '1';

const HOUR = 3600e3;
const DAY = 86400e3;

/* ───────── 계산 (순수 함수 — test/hit_watch.test.js 에서 검증) ───────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const kstDate = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const reelCode = (url) => (url || '').match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/)?.[1] || '';

/* 그 릴스 게시 전 N일 우리 릴스 도달의 중앙값. 4개가 안 모이면 기간을 넓힌다. */
function baselineFor(reel, reels, rules = RULES) {
  for (const days of rules.BASELINE_WINDOWS_DAYS) {
    const from = reel.postedAt - days * DAY;
    const prior = reels
      .filter((r) => r !== reel && r.postedAt >= from && r.postedAt < reel.postedAt)
      .filter((r) => r.reach >= rules.BASELINE_MIN_REACH)
      .map((r) => r.reach);
    if (prior.length >= rules.BASELINE_MIN_REELS) {
      return { median: median(prior), count: prior.length, days };
    }
  }
  return null;
}

/* 지금 수치가 어느 기준을 넘었는지 */
function evaluate(reel, baseline, rules = RULES) {
  const multiple = baseline && baseline.median > 0 ? reel.reach / baseline.median : null;
  const shareRate = reel.reach > 0 ? (reel.shares / reel.reach) * 100 : 0;
  const saveRate = reel.reach > 0 ? (reel.saves / reel.reach) * 100 : 0;
  const passed = [];
  if (multiple != null && multiple >= rules.REACH_MULTIPLE) passed.push(PASS.REACH);
  if (shareRate >= rules.SHARE_RATE_PCT && reel.reach >= rules.SHARE_MIN_REACH) passed.push(PASS.SHARE);
  if ((reel.avgWatch || 0) >= rules.WATCH_SECONDS) passed.push(PASS.WATCH);
  const hit = passed.includes(PASS.REACH) || passed.includes(PASS.SHARE);
  return { multiple, shareRate, saveRate, passed, hit };
}

/* 아직 행이 없는 릴스를 지금 판정할지. null 이면 이번 실행에서는 넘어간다.
 * dataAgeHours = 게시 시각부터 '마지막 수집' 시각까지 (수치가 몇 시간째 값인지) */
function planNew(dataAgeHours, ev, rules = RULES) {
  if (dataAgeHours < rules.EARLY_HIT_AFTER_HOURS || dataAgeHours > rules.CREATE_UNTIL_HOURS) return null;
  if (dataAgeHours < rules.JUDGE_AFTER_HOURS) {
    // 20시간 전에는 '도달 2배'를 이미 넘은 경우만 미리 히트로 판정한다.
    // (공유 비율은 초반에 출렁이므로 20시간 뒤에 본다)
    return ev.passed.includes(PASS.REACH) ? { verdict: VERDICT.HIT, early: true } : null;
  }
  return { verdict: ev.hit ? VERDICT.HIT : VERDICT.NORMAL, early: false };
}

/* '평소'로 판정된 릴스가 7일 안에 뒤늦게 2배를 넘었는지 */
function isLateHit(row, reel, dataAgeHours, rules = RULES) {
  if (row.verdict !== VERDICT.NORMAL) return false;
  if (dataAgeHours > rules.LATE_HIT_UNTIL_HOURS) return false;
  if (!row.baselineMedian || row.baselineMedian <= 0) return false;
  return reel.reach / row.baselineMedian >= rules.REACH_MULTIPLE;
}

/* 게시 전날 → 게시 3일 뒤 팔로워 수 변화와, 평소 하루 증감을 뺀 '추가 팔로워'.
 * snapshots: [{ date: 'YYYY-MM-DD'(KST), followers }], todayKst: 오늘 날짜(아직 갱신 중인 행은 쓰지 않음)
 * 끝 날짜의 기록이 아직 없으면 null (다음 실행에서 다시 시도). */
function followerLift(postedAt, snapshots, todayKst, rules = RULES) {
  const byDate = new Map(snapshots.filter((s) => s.date && s.followers > 0).map((s) => [s.date, s.followers]));
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return null;

  const postDate = kstDate(postedAt);
  const startTarget = addDays(postDate, -1);
  const endTarget = addDays(postDate, rules.LIFT_DAYS_AFTER);
  // 그 날짜 기록이 없으면 시작은 가장 가까운 이전(5일 안), 끝은 가장 가까운 이후(3일 안)
  const startDate = [...dates].reverse().find((d) => d <= startTarget && dayDiff(d, startTarget) <= 5);
  const endDate = dates.find((d) => d >= endTarget && d < todayKst && dayDiff(endTarget, d) <= 3);
  if (!startDate || !endDate) return null;

  const days = dayDiff(startDate, endDate);
  const raw = byDate.get(endDate) - byDate.get(startDate);

  // 평소 하루 증감 = 시작일 이전 14일의 하루 변화 중앙값 (다른 히트의 급증에 덜 흔들리게 중앙값)
  const windowFrom = addDays(startDate, -rules.LIFT_BASELINE_DAYS);
  const win = dates.filter((d) => d >= windowFrom && d <= startDate);
  const daily = [];
  for (let i = 1; i < win.length; i++) {
    const gap = dayDiff(win[i - 1], win[i]);
    const perDay = (byDate.get(win[i]) - byDate.get(win[i - 1])) / gap;
    for (let k = 0; k < gap; k++) daily.push(perDay);
  }
  if (daily.length < rules.LIFT_BASELINE_MIN_DAYS) {
    return { raw, days, startDate, endDate, dailyBaseline: null, extra: null };
  }
  const dailyBaseline = median(daily);
  return { raw, days, startDate, endDate, dailyBaseline, extra: Math.round(raw - dailyBaseline * days) };
}

/* 게시일 앞뒤 3일 안에 올라간 다른 릴스 (팔로워 증감 기간이 겹치는 릴스) */
function overlappingReels(reel, reels, rules = RULES) {
  const d0 = kstDate(reel.postedAt);
  return reels.filter((o) => o !== reel && Math.abs(dayDiff(d0, kstDate(o.postedAt))) <= rules.LIFT_DAYS_AFTER);
}

const fmtCount = (n) => (n >= 10000 ? `${round(n / 10000, 1)}만` : Math.round(n).toLocaleString('ko-KR'));
const captionHead = (name, max = 24) => (name || '').split('\n')[0].trim().slice(0, max) || '(캡션 없음)';
const rowTitle = (reel) => {
  const [, m, d] = kstDate(reel.postedAt).split('-');
  return `${Number(m)}/${Number(d)} ${captionHead(reel.name)}`;
};

/* 디스코드 알림 문구. 한 줄에 숫자 2개까지, 폰 알림으로 읽히게. */
function buildDiscordMessage(reel, ev, ageHours, { late = false } = {}) {
  const lines = [];
  lines.push(late ? '🔥 릴스가 뒤늦게 올라오고 있어요' : '🔥 릴스가 평소보다 잘 나가고 있어요');
  lines.push(`「${captionHead(reel.name)}」 · 올린 지 ${Math.round(ageHours)}시간`);
  lines.push(
    ev.multiple != null
      ? `도달 ${fmtCount(reel.reach)} — 평소 릴스의 ${ev.multiple.toFixed(1)}배`
      : `도달 ${fmtCount(reel.reach)}`
  );
  lines.push(`공유 ${Math.round(reel.shares).toLocaleString('ko-KR')}회 — 도달의 ${ev.shareRate.toFixed(2)}%`);
  if (reel.avgWatch) lines.push(`평균 시청 ${reel.avgWatch}초`);
  lines.push('');
  lines.push('지금 해볼 만한 것');
  lines.push('① 2~3일 안에 같은 소재로 후속 릴스');
  lines.push('② 프로필 고정 게시물과 소개 문구 점검');
  lines.push('③ 고정 댓글에 다음 공구 일정 — 팔로우해 둘 이유');
  if (reel.link) lines.push(reel.link);
  return lines.join('\n');
}

/* ───────── Notion ───────── */

async function notionRequest(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${CONFIG.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok || data.object === 'error') {
    console.error(`[Notion Error] ${method} ${endpoint} → ${res.status}:`, data.message || JSON.stringify(data));
    data._httpStatus = res.status;
  }
  return data;
}

/* 실패하면 null (빈 결과 [] 와 구분) */
async function queryAll(dbId, filter) {
  let all = [];
  let cursor;
  while (true) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(`databases/${dbId}/query`, 'POST', body);
    if (data.object === 'error') return null;
    all = all.concat(data.results || []);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

const plain = (prop) => (prop?.title || prop?.rich_text || []).map((t) => t.plain_text).join('');
const rt = (s) => ({ rich_text: [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] });
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function toReel(page) {
  const p = page.properties || {};
  const posted = p['날짜']?.date?.start;
  const collected = p['마지막 수집일']?.date?.start;
  const product = p['상품/브랜드'];
  return {
    pageId: page.id,
    igId: plain(p['Instagram ID']).trim(),
    name: plain(p['이름']),
    postedAt: posted ? Date.parse(posted) : NaN,
    collectedAt: collected ? Date.parse(collected) : null,
    reach: p['도달']?.number || 0,
    shares: p['공유']?.number || 0,
    saves: p['저장']?.number || 0,
    avgWatch: p['평균 시청 시간(초)']?.number || 0,
    link: p['원본 URL']?.url || '',
    product: (product?.multi_select || []).map((o) => o.name).join(' · ') || product?.select?.name || '',
  };
}

function toHitRow(page) {
  const p = page.properties || {};
  return {
    pageId: page.id,
    igId: plain(p['Instagram ID']).trim(),
    code: reelCode(p['링크']?.url),
    verdict: p['판정']?.select?.name || '',
    alert: p['알림']?.select?.name || '',
    passed: (p['통과한 기준']?.multi_select || []).map((o) => o.name),
    baselineMedian: p['기준 중앙값']?.number ?? null,
    lift: p['3일 팔로워 증감']?.number ?? null,
    reach7: p['7일 도달']?.number ?? null,
    memo: plain(p['메모']),
  };
}

async function loadReels(now) {
  const pages = await queryAll(CONFIG.BRAND_DB_ID, {
    and: [
      { property: '채널', select: { equals: '릴스' } },
      { property: '날짜', date: { on_or_after: isoDay(now - RULES.LOOKBACK_DAYS * DAY) } },
    ],
  });
  if (pages === null) return null;
  return pages.map(toReel).filter((r) => Number.isFinite(r.postedAt));
}

async function loadHitRows(now) {
  const pages = await queryAll(CONFIG.HIT_DB_ID, {
    property: '게시일',
    date: { on_or_after: isoDay(now - RULES.HIT_ROWS_LOOKBACK_DAYS * DAY) },
  });
  if (pages === null) return null;
  return pages.map(toHitRow);
}

async function loadSnapshots(now) {
  const pages = await queryAll(CONFIG.ACCOUNT_DB_ID, {
    and: [
      { property: '유형', select: { equals: '일일' } },
      { property: '날짜', date: { on_or_after: isoDay(now - 45 * DAY) } },
    ],
  });
  if (pages === null) return [];
  return pages.map((pg) => ({
    date: (pg.properties?.['날짜']?.date?.start || '').slice(0, 10),
    followers: pg.properties?.['팔로워 수']?.number || 0,
  }));
}

function metricProps(reel, ev, baselineMedian, dataAgeHours, judgedAt) {
  const props = {
    '판정 시각': { date: { start: new Date(judgedAt).toISOString() } },
    '판정 시점(시간)': { number: Math.round(dataAgeHours) },
    '도달': { number: reel.reach },
    '공유/도달 %': { number: round(ev.shareRate, 2) },
    '저장/도달 %': { number: round(ev.saveRate, 2) },
    '평균 시청(초)': { number: reel.avgWatch || 0 },
  };
  if (ev.multiple != null) props['평소 대비 배수'] = { number: round(ev.multiple, 1) };
  if (baselineMedian != null) props['기준 중앙값'] = { number: Math.round(baselineMedian) };
  return props;
}

/* 만든 행의 id (실패하면 null) */
async function createHitRow(properties) {
  const res = await notionRequest('pages', 'POST', { parent: { database_id: CONFIG.HIT_DB_ID }, properties });
  return res.object === 'error' ? null : res.id;
}

async function updateHitRow(pageId, properties) {
  const res = await notionRequest(`pages/${pageId}`, 'PATCH', { properties });
  return res.object !== 'error';
}

/* ───────── Discord ───────── */

async function sendDiscord(content) {
  if (!CONFIG.DISCORD_WEBHOOK_URL) return ALERT.NO_WEBHOOK;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'instagram-tracker-hit-watch' },
        body: JSON.stringify({ content: content.slice(0, 1900) }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return ALERT.SENT;
      console.error(`[Discord] 전송 실패 (HTTP ${res.status}), 시도 ${attempt}/2`);
    } catch (e) {
      // 오류 메시지에 웹후크 주소가 섞이지 않게 종류만 찍는다
      console.error(`[Discord] 전송 예외 (${e.name}), 시도 ${attempt}/2`);
    }
    if (attempt < 2) await sleep(CONFIG.DISCORD_RETRY_MS);
  }
  return ALERT.FAILED;
}

/* ───────── 메인 ───────── */

async function run({ now = Date.now(), dryRun = DRY_RUN } = {}) {
  if (!CONFIG.NOTION_TOKEN || !CONFIG.BRAND_DB_ID) {
    throw new Error('필수 환경 변수가 누락되었습니다. (NOTION_TOKEN, NOTION_DB_ID)');
  }
  const todayKst = kstDate(now);
  console.log(`=== Hit Watch Start · ${todayKst}${dryRun ? ' · DRY RUN' : ''}${CONFIG.DISCORD_WEBHOOK_URL ? '' : ' · 웹후크 없음(노션에만 기록)'} ===`);

  const reels = await loadReels(now);
  if (reels === null) {
    throw new Error('브랜드 action을 읽지 못했습니다. NOTION_DB_ID와 통합 연결을 확인하세요.');
  }
  const hitRows = await loadHitRows(now);
  if (hitRows === null) {
    throw new Error(
      "'히트 판정' DB를 읽지 못했습니다. 노션에서 '히트 판정' DB 페이지 ⋯ → 연결 → 이 스크립트가 쓰는 통합을 추가했는지 확인하세요."
    );
  }
  const rowByIg = new Map(hitRows.filter((r) => r.igId).map((r) => [r.igId, r]));
  const rowByCode = new Map(hitRows.filter((r) => r.code).map((r) => [r.code, r]));
  const findRow = (r) => (r.igId && rowByIg.get(r.igId)) || rowByCode.get(reelCode(r.link));
  const verdictNow = new Map(); // 이번 실행에서 새로 정해진 판정 (릴스 객체 → 판정)
  const verdictOf = (r) => verdictNow.get(r) || findRow(r)?.verdict || '';
  console.log(`릴스 ${reels.length}개(최근 ${RULES.LOOKBACK_DAYS}일) · 판정 행 ${hitRows.length}개(최근 ${RULES.HIT_ROWS_LOOKBACK_DAYS}일)`);

  let snapshots = null; // 필요할 때만 읽는다
  const stats = { judged: 0, hits: 0, late: 0, alerts: 0, lift: 0, seven: 0, errors: 0 };
  const recent = reels
    .filter((r) => now - r.postedAt <= (RULES.HIT_ROWS_LOOKBACK_DAYS - 1) * DAY)
    .sort((a, b) => a.postedAt - b.postedAt);

  for (const reel of recent) {
    const label = reel.igId || reel.pageId;
    const nowAgeHours = (now - reel.postedAt) / HOUR;
    // 수치는 '마지막 수집' 시점의 값이다. 수집이 멈춰 있으면 그 시점 기준으로 본다.
    const dataAt = reel.collectedAt && reel.collectedAt > reel.postedAt ? Math.min(reel.collectedAt, now) : now;
    const dataAgeHours = (dataAt - reel.postedAt) / HOUR;
    const row = findRow(reel);

    if (!row) {
      if (reel.reach <= 0) continue; // 인사이트가 아직 안 들어옴 — 다음 실행에서
      const baseline = baselineFor(reel, reels);
      const ev = evaluate(reel, baseline);
      const plan = planNew(dataAgeHours, ev);
      if (!plan) continue;

      const isHit = plan.verdict === VERDICT.HIT;
      const wantsAlert = isHit && nowAgeHours <= RULES.ALERT_UNTIL_HOURS;
      // 알림 칸은 '실패'(아직 못 보냄)로 먼저 적고, 보낸 뒤 '보냄'으로 바꾼다.
      // 행을 먼저 만들어 두면 중간에 멈춰도 같은 알림이 실행마다 되풀이되지 않는다.
      const alertBefore = !wantsAlert ? ALERT.NOT_TARGET : CONFIG.DISCORD_WEBHOOK_URL ? ALERT.FAILED : ALERT.NO_WEBHOOK;
      const memo = [];
      if (plan.early) memo.push(`게시 ${Math.round(dataAgeHours)}시간째에 이미 2배를 넘어 미리 판정`);
      if (!baseline) memo.push('기준으로 삼을 릴스가 4개 미만이라 배수 없음');
      if (isHit && !wantsAlert) memo.push('게시 48시간이 지나 알림은 보내지 않음');

      const properties = {
        '릴스': { title: [{ type: 'text', text: { content: rowTitle(reel) } }] },
        '판정': { select: { name: plan.verdict } },
        '게시일': { date: { start: new Date(reel.postedAt).toISOString() } },
        ...metricProps(reel, ev, baseline?.median ?? null, dataAgeHours, dataAt),
        '통과한 기준': { multi_select: ev.passed.map((name) => ({ name })) },
        '알림': { select: { name: alertBefore } },
        'Instagram ID': rt(reel.igId),
      };
      if (reel.product) properties['상품/브랜드'] = rt(reel.product);
      if (reel.link) properties['링크'] = { url: reel.link };
      if (memo.length) properties['메모'] = rt(memo.join(' · '));

      let alertLog = alertBefore;
      if (dryRun) {
        if (wantsAlert) alertLog = '보낼 대상(DRY RUN이라 보내지 않음)';
      } else {
        const pageId = await createHitRow(properties);
        if (!pageId) { stats.errors++; console.error(`[판정] ${label} 행을 만들지 못해 알림도 보내지 않음`); continue; }
        if (wantsAlert && CONFIG.DISCORD_WEBHOOK_URL) {
          alertLog = await sendDiscord(buildDiscordMessage(reel, ev, dataAgeHours));
          if (alertLog === ALERT.SENT) {
            stats.alerts++;
            if (!(await updateHitRow(pageId, { '알림': { select: { name: ALERT.SENT } } }))) stats.errors++;
          }
        }
      }
      console.log(
        `[판정] ${label} → ${plan.verdict}${ev.passed.length ? ` (${ev.passed.join(', ')})` : ''} · 알림 ${alertLog}` +
        (VERBOSE ? ` · ${Math.round(dataAgeHours)}h 도달 ${reel.reach} 배수 ${ev.multiple?.toFixed(2)} 공유% ${ev.shareRate.toFixed(2)}` : '')
      );
      verdictNow.set(reel, plan.verdict);
      stats.judged++;
      if (isHit) stats.hits++;
      await sleep(CONFIG.WRITE_DELAY_MS);
      continue;
    }

    // ── 이미 행이 있는 릴스: 뒤늦은 히트 / 알림 재시도 / 3일 증감 / 7일 수치 ──
    const patch = {};
    const memoAdd = [];

    if (reel.reach > 0 && isLateHit(row, reel, dataAgeHours)) {
      const ev = evaluate(reel, { median: row.baselineMedian });
      const alertBefore = CONFIG.DISCORD_WEBHOOK_URL ? ALERT.FAILED : ALERT.NO_WEBHOOK;
      const lateProps = {
        ...metricProps(reel, ev, row.baselineMedian, dataAgeHours, dataAt),
        '판정': { select: { name: VERDICT.HIT } },
        '통과한 기준': { multi_select: [...new Set([...ev.passed.filter((n) => n !== PASS.REACH), PASS.LATE])].map((name) => ({ name })) },
        '알림': { select: { name: alertBefore } },
        '메모': rt([row.memo, `처음 판정은 평소였고 게시 ${Math.round(dataAgeHours)}시간째에 2배를 넘음`].filter(Boolean).join(' · ')),
      };
      let alertLog = dryRun ? '보낼 대상(DRY RUN이라 보내지 않음)' : alertBefore;
      // 판정을 먼저 적는다. 못 적으면 알리지 않는다 (다음 실행에서 같은 알림이 되풀이되지 않게)
      if (!dryRun) {
        if (!(await updateHitRow(row.pageId, lateProps))) {
          stats.errors++;
          console.error(`[뒤늦은 히트] ${label} 판정을 적지 못해 알림도 보내지 않음`);
          continue;
        }
        row.verdict = VERDICT.HIT;
        row.memo = lateProps['메모'].rich_text[0].text.content;
        if (CONFIG.DISCORD_WEBHOOK_URL) {
          alertLog = await sendDiscord(buildDiscordMessage(reel, ev, dataAgeHours, { late: true }));
          if (alertLog === ALERT.SENT) { stats.alerts++; patch['알림'] = { select: { name: ALERT.SENT } }; }
        }
        await sleep(CONFIG.WRITE_DELAY_MS);
      }
      verdictNow.set(reel, VERDICT.HIT);
      stats.late++;
      console.log(`[뒤늦은 히트] ${label} · 알림 ${alertLog}`);
    } else if (row.verdict === VERDICT.HIT && row.alert === ALERT.FAILED && nowAgeHours <= RULES.ALERT_UNTIL_HOURS && reel.reach > 0) {
      const ev = evaluate(reel, row.baselineMedian ? { median: row.baselineMedian } : null);
      const alert = dryRun ? ALERT.FAILED : await sendDiscord(buildDiscordMessage(reel, ev, dataAgeHours));
      if (alert === ALERT.SENT) { stats.alerts++; patch['알림'] = { select: { name: alert } }; }
      console.log(`[알림 재시도] ${label} · ${alert}`);
    }

    if (row.lift == null && nowAgeHours >= RULES.LIFT_AFTER_HOURS) {
      if (snapshots === null) snapshots = await loadSnapshots(now);
      const lift = followerLift(reel.postedAt, snapshots, todayKst);
      if (lift) {
        // 팔로워 증감은 그 기간에 올라간 릴스가 함께 만든 값이다. 릴스별로 나눌 수 없으므로
        // 전환율은 '앞뒤 3일 안에 다른 히트가 없는 히트'에만 적는다.
        const isHit = verdictOf(reel) === VERDICT.HIT;
        const otherHits = overlappingReels(reel, reels).filter((o) => verdictOf(o) === VERDICT.HIT).length;
        patch['3일 팔로워 증감'] = { number: lift.raw };
        if (lift.extra != null) {
          patch['평소 대비 추가 팔로워'] = { number: lift.extra };
          if (isHit && !otherHits && reel.reach > 0) {
            patch['팔로우 전환 %'] = { number: lift.extra > 0 ? round((lift.extra / reel.reach) * 100, 2) : 0 };
          }
        }
        memoAdd.push(`팔로워 ${lift.startDate.slice(5)}→${lift.endDate.slice(5)} ${lift.days}일`);
        if (otherHits) {
          memoAdd.push(isHit
            ? `다른 히트 ${otherHits}개와 기간이 겹쳐 전환율은 따로 재지 않음`
            : `히트 ${otherHits}개와 기간이 겹침(추가 팔로워는 그 히트의 몫일 수 있음)`);
        }
        stats.lift++;
        console.log(`[3일 증감] ${label}${VERBOSE ? ` · ${lift.raw} (추가 ${lift.extra})` : ''}`);
      }
    }

    if (row.reach7 == null && dataAgeHours >= RULES.SEVEN_DAY_HOURS && reel.reach > 0) {
      patch['7일 도달'] = { number: reel.reach };
      if (row.baselineMedian > 0) patch['7일 배수'] = { number: round(reel.reach / row.baselineMedian, 1) };
      stats.seven++;
      console.log(`[7일 수치] ${label}`);
    }

    if (memoAdd.length) patch['메모'] = rt([row.memo, ...memoAdd].filter(Boolean).join(' · '));
    if (Object.keys(patch).length && !dryRun) {
      if (!(await updateHitRow(row.pageId, patch))) stats.errors++;
      await sleep(CONFIG.WRITE_DELAY_MS);
    }
  }

  console.log(
    `=== 완료 | 새 판정 ${stats.judged} (히트 ${stats.hits}) | 뒤늦은 히트 ${stats.late} | 알림 ${stats.alerts}` +
    ` | 3일 증감 ${stats.lift} | 7일 수치 ${stats.seven} | 오류 ${stats.errors} ===`
  );
  return stats;
}

module.exports = {
  CONFIG, RULES, VERDICT, PASS, ALERT, run,
  median, round, kstDate, addDays, dayDiff, reelCode,
  baselineFor, evaluate, planNew, isLateHit, followerLift, overlappingReels,
  fmtCount, captionHead, rowTitle, buildDiscordMessage, toReel, toHitRow,
};

if (require.main === module) {
  run()
    .then((stats) => { if (stats.errors) process.exit(1); })
    .catch((e) => { console.error('[치명적 오류]', e.message || e); process.exit(1); });
}
