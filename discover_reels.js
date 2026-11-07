/**
 * discover_reels.js — 레퍼런스 릴스 자동 발굴
 *
 * 흐름
 *   노션 '레퍼런스 계정 풀'(상태=활성) → 계정마다 Business Discovery로 최근 미디어 25개
 *   → 릴스만 추려 그 계정의 좋아요 중앙값 계산 → 중앙값 대비 2.5배↑(또는 좋아요 숨김이면 댓글 3배↑)
 *   → 아직 큐에 없는 링크만 '릴스 해부 큐'에 상태 '후보'로 적재
 *   → 계정 풀 행에 팔로워·중앙값·최근 릴스 수·마지막 점검·점검 메모 되쓰기
 *
 * '후보'는 벤치마크 예약 작업(화·금)이 읽고 '대기'(PC worker가 해부) 또는 '보류'로 바꾼다.
 *
 * 필수 환경 변수: NOTION_TOKEN, INSTAGRAM_TOKEN
 * 선택: INSTAGRAM_ACCOUNT_ID (없으면 me/accounts에서 탐색),
 *       REF_POOL_DB_ID, QUEUE_DB_ID (기본값 아래),
 *       DRY_RUN=1 (노션에 쓰지 않고 로그만)
 *
 * 테스트
 *   node discover_reels.js --account corub_i        # 계정 1개만, DRY_RUN
 *   node discover_reels.js --hashtag 하체코디        # 해시태그 top_media가 우리 앱에서 되는지 확인
 */

const CONFIG = {
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  INSTAGRAM_TOKEN: process.env.INSTAGRAM_TOKEN,
  INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID,
  REF_POOL_DB_ID: process.env.REF_POOL_DB_ID || 'd8e534af62f24553a026214f1acdcd9d',
  QUEUE_DB_ID: process.env.QUEUE_DB_ID || '1e4e09b7d53648b689af4186019c15df',
  IG_BASE_URL: 'https://graph.facebook.com/v25.0/',

  MEDIA_LIMIT: 25,          // 계정당 최근 미디어
  MIN_REELS_FOR_BASELINE: 5, // 이보다 릴스가 적으면 중앙값 신뢰 못 함 → 건너뜀
  LIKE_MULTIPLE: 2.5,       // 좋아요 중앙값 대비
  COMMENT_MULTIPLE: 3.0,    // 좋아요 숨김 계정은 댓글 중앙값 대비
  MIN_LIKES: 300,           // 배수가 높아도 절대값이 너무 작으면 제외
  WINDOW_DAYS: 60,          // 이보다 오래된 릴스는 후보 제외
  SETTLE_DAYS: 3,           // 게시 3일 미만은 숫자가 덜 쌓여서 제외
  MAX_CANDIDATES_PER_RUN: 30,
  MAX_PER_ACCOUNT: 3,
  CALL_DELAY_MS: 400,
};

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const ONLY_ACCOUNT = argValue('--account');
const HASHTAG_TEST = argValue('--hashtag');
const DRY_RUN = process.env.DRY_RUN === '1' || !!ONLY_ACCOUNT || !!HASHTAG_TEST;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;
const kstDate = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/* ───────── Instagram ───────── */

async function igGet(path, params = {}) {
  const url = new URL(CONFIG.IG_BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', CONFIG.INSTAGRAM_TOKEN);
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const e = new Error(data.error.message || 'IG error');
    e.code = data.error.code;
    e.subcode = data.error.error_subcode;
    throw e;
  }
  return data;
}

let resolvedIgAccountId = null;
async function findIgAccountId() {
  if (CONFIG.INSTAGRAM_ACCOUNT_ID) return CONFIG.INSTAGRAM_ACCOUNT_ID;
  if (resolvedIgAccountId) return resolvedIgAccountId;
  const data = await igGet('me/accounts', { fields: 'instagram_business_account' });
  for (const page of data.data || []) {
    if (page.instagram_business_account) {
      resolvedIgAccountId = page.instagram_business_account.id;
      return resolvedIgAccountId;
    }
  }
  throw new Error('IG 계정 ID를 찾을 수 없음. INSTAGRAM_ACCOUNT_ID를 설정하세요.');
}

/* 다른 비즈니스/크리에이터 계정의 최근 미디어 */
async function businessDiscovery(igUserId, username) {
  const fields =
    `business_discovery.username(${username}){username,followers_count,media_count,` +
    `media.limit(${CONFIG.MEDIA_LIMIT}){id,media_type,media_product_type,like_count,comments_count,permalink,timestamp,caption}}`;
  const data = await igGet(igUserId, { fields });
  return data.business_discovery;
}

/* 해시태그 top_media 테스트 (앱 리뷰 없이 되는지 확인용) */
async function hashtagTest(igUserId, tag) {
  console.log(`[해시태그 테스트] #${tag}`);
  const found = await igGet('ig_hashtag_search', { user_id: igUserId, q: tag });
  const hashtagId = found.data?.[0]?.id;
  if (!hashtagId) { console.log('해시태그 ID 없음:', JSON.stringify(found)); return; }
  const top = await igGet(`${hashtagId}/top_media`, {
    user_id: igUserId,
    fields: 'id,media_type,media_product_type,like_count,comments_count,permalink,timestamp,caption',
    limit: 25,
  });
  const rows = (top.data || []).map((m) => ({
    permalink: m.permalink,
    type: m.media_product_type || m.media_type,
    likes: m.like_count ?? '(숨김)',
    comments: m.comments_count,
    date: (m.timestamp || '').slice(0, 10),
    caption: (m.caption || '').split('\n')[0].slice(0, 40),
  }));
  console.table(rows);
  console.log(`→ ${rows.length}건. 이게 보이면 해시태그 발굴도 쓸 수 있음(주 30개 해시태그 한도).`);
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

async function queryAll(dbId, filter) {
  let all = [];
  let cursor;
  while (true) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(`databases/${dbId}/query`, 'POST', body);
    if (data.object === 'error') break;
    all = all.concat(data.results || []);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

const plain = (prop) => (prop?.title || prop?.rich_text || []).map((t) => t.plain_text).join('');
const rt = (s) => ({ rich_text: [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] });

/* 계정 풀: 활성 계정 */
async function loadPool() {
  const rows = await queryAll(CONFIG.REF_POOL_DB_ID, {
    property: '상태', select: { equals: '활성' },
  });
  return rows
    .map((r) => ({
      pageId: r.id,
      username: plain(r.properties['계정']).trim().replace(/^@/, ''),
      category: r.properties['카테고리']?.select?.name || '',
      found: r.properties['누적 발굴']?.number || 0,
    }))
    .filter((r) => r.username);
}

/* 큐: 이미 들어간 링크(모든 상태) — 릴스 코드 기준으로 중복 판정 */
const reelCode = (url) => (url || '').match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/)?.[1] || url;
async function loadQueuedCodes() {
  const rows = await queryAll(CONFIG.QUEUE_DB_ID);
  const set = new Set();
  for (const r of rows) {
    const link = r.properties['링크']?.url;
    if (link) set.add(reelCode(link));
  }
  return set;
}

async function addCandidate(c) {
  const props = {
    제목: { title: [{ type: 'text', text: { content: `${c.username} · ${c.captionHead || '(캡션 없음)'}`.slice(0, 200) } }] },
    링크: { url: c.permalink },
    상태: { status: { name: '후보' } },
    출처: { select: { name: '리서치팀' } },
    용도: { select: { name: '레퍼런스' } },
    계정: rt(c.username),
    '평소 대비 배수': { number: Math.round(c.multiple * 10) / 10 },
    메모: rt(
      `자동 발굴 ${kstDate()} · ${c.basis} · 게시 ${c.date} · 카테고리 ${c.category || '-'} · ` +
      `팔로워 ${c.followers?.toLocaleString() || '-'} · ${c.captionHead || ''}`
    ),
  };
  if (DRY_RUN) { console.log('  [DRY] 큐 적재:', c.permalink, `${c.multiple.toFixed(1)}배`, c.basis); return true; }
  const res = await notionRequest('pages', 'POST', { parent: { database_id: CONFIG.QUEUE_DB_ID }, properties: props });
  return res.object !== 'error';
}

async function updatePoolRow(pageId, patch) {
  if (DRY_RUN) { console.log('  [DRY] 계정 풀 갱신:', JSON.stringify(patch)); return; }
  const props = {
    '마지막 점검': { date: { start: kstDate() } },
    '점검 메모': rt(patch.note || ''),
  };
  if (patch.followers != null) props['팔로워'] = { number: patch.followers };
  if (patch.medianLikes != null) props['평소 좋아요 중앙값'] = { number: patch.medianLikes };
  if (patch.recentReels != null) props['최근 릴스 수'] = { number: patch.recentReels };
  if (patch.found != null) props['누적 발굴'] = { number: patch.found };
  await notionRequest(`pages/${pageId}`, 'PATCH', { properties: props });
}

/* ───────── 계정 1개 처리 ───────── */

async function scanAccount(igUserId, acct, queued) {
  let bd;
  try {
    bd = await businessDiscovery(igUserId, acct.username);
  } catch (e) {
    // 110/100 (subcode 2207013 등): 비즈니스/크리에이터 계정이 아니거나 비공개
    const note = `조회 실패 ${kstDate()}: ${e.message}`.slice(0, 300);
    console.log(`  ✗ ${acct.username}: ${e.message}`);
    await updatePoolRow(acct.pageId, { note });
    return [];
  }

  const media = bd.media?.data || [];
  const reels = media.filter((m) => m.media_product_type === 'REELS' || m.media_type === 'VIDEO');
  const withLikes = reels.filter((m) => typeof m.like_count === 'number');
  const likesHidden = reels.length >= 3 && withLikes.length < reels.length / 2;

  const baseLikes = median(withLikes.map((m) => m.like_count));
  const baseComments = median(reels.map((m) => m.comments_count || 0));
  const recentReels = reels.filter((m) => daysAgo(m.timestamp) <= CONFIG.WINDOW_DAYS).length;

  if (reels.length < CONFIG.MIN_REELS_FOR_BASELINE) {
    const note = `릴스 ${reels.length}개뿐 — 기준선 불가`;
    console.log(`  – ${acct.username}: ${note}`);
    await updatePoolRow(acct.pageId, { followers: bd.followers_count, recentReels, note });
    return [];
  }

  const picks = [];
  for (const m of reels) {
    const age = daysAgo(m.timestamp);
    if (age > CONFIG.WINDOW_DAYS || age < CONFIG.SETTLE_DAYS) continue;
    if (queued.has(reelCode(m.permalink))) continue;

    let multiple = null, basis = '';
    if (!likesHidden && typeof m.like_count === 'number' && baseLikes > 0) {
      multiple = m.like_count / baseLikes;
      basis = `좋아요 ${m.like_count.toLocaleString()} (중앙값 ${Math.round(baseLikes).toLocaleString()}, ${multiple.toFixed(1)}배) · 댓글 ${m.comments_count}`;
      if (multiple < CONFIG.LIKE_MULTIPLE || m.like_count < CONFIG.MIN_LIKES) continue;
    } else if (baseComments > 0) {
      multiple = (m.comments_count || 0) / baseComments;
      basis = `좋아요 숨김 → 댓글 ${m.comments_count} (중앙값 ${Math.round(baseComments)}, ${multiple.toFixed(1)}배)`;
      if (multiple < CONFIG.COMMENT_MULTIPLE || (m.comments_count || 0) < 20) continue;
    } else continue;

    picks.push({
      username: acct.username,
      category: acct.category,
      followers: bd.followers_count,
      permalink: m.permalink,
      multiple,
      basis,
      date: (m.timestamp || '').slice(0, 10),
      captionHead: (m.caption || '').split('\n').find((l) => l.trim()) ?.trim().slice(0, 60) || '',
    });
  }

  picks.sort((a, b) => b.multiple - a.multiple);
  const chosen = picks.slice(0, CONFIG.MAX_PER_ACCOUNT);

  const note =
    `${kstDate()} 정상 · 릴스 ${reels.length}/${media.length}` +
    (likesHidden ? ' · 좋아요 숨김(댓글 기준)' : '') +
    (picks.length ? ` · 후보 ${picks.length}` : ' · 후보 없음');
  console.log(`  ✓ ${acct.username}: 팔로워 ${bd.followers_count?.toLocaleString()} · 중앙값 ${baseLikes ?? '-'} · ${note}`);

  await updatePoolRow(acct.pageId, {
    followers: bd.followers_count,
    medianLikes: baseLikes != null ? Math.round(baseLikes) : null,
    recentReels,
    note,
    found: acct.found + chosen.length,
  });
  return chosen;
}

/* ───────── main ───────── */

(async () => {
  if (!CONFIG.NOTION_TOKEN || !CONFIG.INSTAGRAM_TOKEN) {
    console.error('NOTION_TOKEN / INSTAGRAM_TOKEN 필요'); process.exit(1);
  }
  const igUserId = await findIgAccountId();

  if (HASHTAG_TEST) { await hashtagTest(igUserId, HASHTAG_TEST); return; }

  const pool = ONLY_ACCOUNT
    ? [{ pageId: null, username: ONLY_ACCOUNT, category: '(테스트)', found: 0 }]
    : await loadPool();
  console.log(`[발굴 시작] ${kstDate()} · 계정 ${pool.length}개${DRY_RUN ? ' · DRY RUN' : ''}`);
  if (!pool.length) { console.log('활성 계정 없음'); return; }

  const queued = ONLY_ACCOUNT ? new Set() : await loadQueuedCodes();
  console.log(`큐에 이미 있는 릴스 ${queued.size}건`);

  let all = [];
  for (const acct of pool) {
    const picks = await scanAccount(igUserId, acct, queued);
    all = all.concat(picks);
    await sleep(CONFIG.CALL_DELAY_MS);
  }

  all.sort((a, b) => b.multiple - a.multiple);
  const toAdd = all.slice(0, CONFIG.MAX_CANDIDATES_PER_RUN);
  let added = 0;
  for (const c of toAdd) {
    if (await addCandidate(c)) added++;
    await sleep(150);
  }

  console.log(`\n[발굴 끝] 후보 ${all.length}건 중 ${added}건 큐 적재(상한 ${CONFIG.MAX_CANDIDATES_PER_RUN})`);
  if (all.length) {
    console.table(toAdd.map((c) => ({
      계정: c.username, 배수: c.multiple.toFixed(1), 게시: c.date, 캡션: c.captionHead.slice(0, 30), 링크: c.permalink,
    })));
  }
})().catch((e) => { console.error('[치명적 오류]', e); process.exit(1); });
