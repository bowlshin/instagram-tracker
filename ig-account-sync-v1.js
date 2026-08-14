/**
 * Instagram Account & Story Insights to Notion Sync v1
 *
 * 기존 v3(게시물 인사이트)와 별도로 실행되는 계정 단위 수집 스크립트.
 * v3의 구조(그룹 분할 인사이트 호출, Notion 헬퍼, 404/400 구분)를 그대로 따름.
 *
 * 수집 항목:
 *   [매일]   스토리 인사이트 → Notion `스토리 인사이트` DB
 *            (스토리는 24시간 후 데이터 소멸 → 하루 1회 이상 실행 필수)
 *   [매일]   계정 일일 지표 (도달, 조회수, 프로필 방문, 팔로우 증감, 참여 계정, 팔로워 수)
 *            → Notion `계정 일일 지표` DB (하루 1행, 재실행 시 갱신)
 *   [주 1회] 팔로워 demographic (도시/연령/성별) → 같은 DB에 '주간 스냅샷' 행
 *            (월요일 자동 실행, 또는 FORCE_DEMOGRAPHICS=1 로 강제 실행)
 *
 * 필수 환경 변수: NOTION_TOKEN, INSTAGRAM_TOKEN
 * 선택 환경 변수: INSTAGRAM_ACCOUNT_ID, NOTION_STORY_DB_ID, NOTION_ACCOUNT_DB_ID,
 *                FORCE_DEMOGRAPHICS
 */

const CONFIG = {
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  INSTAGRAM_TOKEN: process.env.INSTAGRAM_TOKEN,
  INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID,
  // 2026-08-14 생성된 DB ID (환경 변수로 덮어쓰기 가능)
  STORY_DB_ID: process.env.NOTION_STORY_DB_ID || '2daf4457855e4883b42b76240c674e7d',
  ACCOUNT_DB_ID: process.env.NOTION_ACCOUNT_DB_ID || '6a2d4561098d4fc6aab823977b72d7fb',
  IG_BASE_URL: 'https://graph.facebook.com/v25.0/',
  FORCE_DEMOGRAPHICS: process.env.FORCE_DEMOGRAPHICS === '1',
};

let resolvedIgAccountId = null;

/* ─────────────────────────── IG 계정 ID 탐색 (v3와 동일) ─────────────────────────── */
async function findIgAccountId() {
  if (CONFIG.INSTAGRAM_ACCOUNT_ID) return CONFIG.INSTAGRAM_ACCOUNT_ID;
  if (resolvedIgAccountId) return resolvedIgAccountId;

  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}me/accounts?fields=instagram_business_account&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    for (const page of (data.data || [])) {
      if (page.instagram_business_account) {
        resolvedIgAccountId = page.instagram_business_account.id;
        console.log('[IG Account] me/accounts에서 찾음:', resolvedIgAccountId);
        return resolvedIgAccountId;
      }
    }
  } catch (e) {
    console.log('[IG Account] me/accounts 실패:', e.message);
  }

  console.error('[IG Account] IG 계정 ID를 찾을 수 없습니다. INSTAGRAM_ACCOUNT_ID를 설정하세요.');
  return null;
}

/* ─────────────────────────── Notion 헬퍼 (v3와 동일) ─────────────────────────── */
async function notionRequest(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok || data.object === 'error') {
    console.error(`[Notion Error] ${method} ${endpoint} → ${res.status}:`, JSON.stringify(data));
    data._httpStatus = res.status;
  }
  return data;
}

async function queryDatabase(dbId, filter) {
  let allResults = [];
  let startCursor = undefined;
  while (true) {
    const body = {};
    if (filter) body.filter = filter;
    if (startCursor) body.start_cursor = startCursor;
    const data = await notionRequest(`databases/${dbId}/query`, 'POST', body);
    if (data.object === 'error') return allResults;
    allResults = allResults.concat(data.results || []);
    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }
  return allResults;
}

async function createPage(dbId, properties) {
  const result = await notionRequest('pages', 'POST', {
    parent: { database_id: dbId },
    properties,
  });
  return { success: result.object !== 'error', id: result.id, error: result.message };
}

async function updatePage(pageId, properties) {
  const result = await notionRequest(`pages/${pageId}`, 'PATCH', { properties });
  return {
    success: result.object !== 'error',
    error: result.message,
    isMissingPage: result._httpStatus === 404,
    isSchemaError: result._httpStatus === 400,
  };
}

/* ─────────────────────── 인사이트 그룹 호출 (v3 fetchInsightGroup 확장) ─────────────────────── */
async function fetchInsightGroup(objectId, metrics, extraParams = '') {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${objectId}/insights?metric=${metrics.join(',')}${extraParams}&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) return { values: {}, raw: [], error: data.error.message };

    const values = {};
    for (const metric of (data.data || [])) {
      // period=day 시계열은 마지막 값, total_value 형은 total_value.value 우선
      values[metric.name] =
        metric.total_value?.value ??
        metric.values?.[metric.values.length - 1]?.value ??
        metric.value ?? 0;
    }
    return { values, raw: data.data || [], error: null };
  } catch (e) {
    return { values: {}, raw: [], error: e.message };
  }
}

/* ══════════════════════════ [Phase 1] 스토리 인사이트 ══════════════════════════ */

async function getActiveStories(igId) {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${igId}/stories?fields=id,media_type,timestamp,permalink&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) {
      console.error('[Story] 목록 조회 실패:', data.error.message);
      return [];
    }
    return data.data || [];
  } catch (e) {
    console.error('[Story] 목록 조회 예외:', e.message);
    return [];
  }
}

/* 스토리 인사이트: 그룹 분할로 일부 지표 거부 시에도 나머지 보존 (v3 방식)
 *   core : views, reach, total_interactions
 *   eng  : replies, shares          — 답장은 지역 정책상(#10) 거부될 수 있음
 *   acct : profile_visits, follows  — 미지원 케이스 격리
 *   nav  : navigation               — 다음으로 넘김/나가기 합계
 */
async function getStoryInsights(storyId) {
  const result = {
    views: 0, reach: 0, totalInteractions: 0,
    replies: 0, shares: 0, profileVisits: 0, follows: 0, navigation: 0,
    insightErrors: [],
  };

  const core = await fetchInsightGroup(storyId, ['views', 'reach', 'total_interactions']);
  if (core.error) result.insightErrors.push(`core: ${core.error}`);
  result.views = core.values.views ?? 0;
  result.reach = core.values.reach ?? 0;
  result.totalInteractions = core.values.total_interactions ?? 0;

  const eng = await fetchInsightGroup(storyId, ['replies', 'shares']);
  if (eng.error) result.insightErrors.push(`eng: ${eng.error}`);
  result.replies = eng.values.replies ?? 0;
  result.shares = eng.values.shares ?? 0;

  const acct = await fetchInsightGroup(storyId, ['profile_visits', 'follows']);
  if (acct.error) result.insightErrors.push(`acct: ${acct.error}`);
  result.profileVisits = acct.values.profile_visits ?? 0;
  result.follows = acct.values.follows ?? 0;

  const nav = await fetchInsightGroup(storyId, ['navigation']);
  if (nav.error) result.insightErrors.push(`nav: ${nav.error}`);
  result.navigation = nav.values.navigation ?? 0;

  return result;
}

async function processStories() {
  console.log('[Step 1] 활성 스토리 수집 중...');
  const igId = await findIgAccountId();
  if (!igId) return { newStories: 0, updated: 0 };

  const stories = await getActiveStories(igId);
  if (stories.length === 0) {
    console.log('[Step 1] 현재 활성 스토리가 없습니다.');
    return { newStories: 0, updated: 0 };
  }
  console.log(`[Step 1] 활성 스토리 ${stories.length}개 확인`);

  // 기존 등록 스토리 확인 (Instagram ID 기준 중복 방지)
  const existingPages = await queryDatabase(CONFIG.STORY_DB_ID, {
    property: 'Instagram ID',
    rich_text: { is_not_empty: true },
  });
  const existingMap = new Map(
    existingPages
      .map(p => [p.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content, p.id])
      .filter(([id]) => Boolean(id))
  );

  let newCount = 0;
  let updatedCount = 0;

  for (const story of stories) {
    const insights = await getStoryInsights(story.id);
    if (insights.insightErrors.length) {
      console.log(`[Step 1] 일부 인사이트 실패 (${story.id}): ${insights.insightErrors.join(' | ')}`);
    }

    const mediaTypeLabel = story.media_type === 'VIDEO' ? '영상' : '이미지';
    const dateLabel = (story.timestamp || '').slice(0, 16).replace('T', ' ');

    const metricProps = {
      '조회수': { number: insights.views },
      '도달': { number: insights.reach },
      '답장': { number: insights.replies },
      '공유': { number: insights.shares },
      '프로필 방문': { number: insights.profileVisits },
      '팔로우': { number: insights.follows },
      '다음으로 넘김': { number: insights.navigation },
      '총 반응 수': { number: insights.totalInteractions },
      '마지막 수집일': { date: { start: new Date().toISOString() } },
    };

    if (existingMap.has(story.id)) {
      // 24시간 내 재실행 → 최신 수치로 갱신
      const upd = await updatePage(existingMap.get(story.id), metricProps);
      if (upd.isSchemaError) {
        console.error(`[Step 1] 속성/스키마 오류 (HTTP 400): ${story.id} → ${upd.error || ''}`);
      } else if (upd.success) {
        console.log(`[Step 1] 스토리 갱신: ${story.id}`);
        updatedCount++;
      }
    } else {
      const properties = {
        '이름': { title: [{ type: 'text', text: { content: `스토리 ${dateLabel}` } }] },
        'Instagram ID': { rich_text: [{ type: 'text', text: { content: story.id } }] },
        '게시일시': { date: { start: story.timestamp } },
        '미디어 유형': { select: { name: mediaTypeLabel } },
        ...metricProps,
      };
      const result = await createPage(CONFIG.STORY_DB_ID, properties);
      if (result.success) {
        console.log(`[Step 1] 스토리 신규 등록: ${story.id} (${mediaTypeLabel})`);
        newCount++;
      } else {
        console.log(`[Step 1] 스토리 등록 실패: ${story.id} → ${result.error || ''}`);
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { newStories: newCount, updated: updatedCount };
}

/* ══════════════════════════ [Phase 2] 계정 일일 지표 ══════════════════════════ */

async function getAccountDailyMetrics(igId) {
  const result = {
    reach: 0, views: 0, profileViews: 0,
    followsNet: 0, accountsEngaged: 0, followersCount: 0,
    insightErrors: [],
  };

  // reach 는 period=day 시계열형 (metric_type 불필요)
  const reach = await fetchInsightGroup(igId, ['reach'], '&period=day');
  if (reach.error) result.insightErrors.push(`reach: ${reach.error}`);
  result.reach = reach.values.reach ?? 0;

  // total_value 형 지표 — 하나라도 거부되면 전체 실패하므로 그룹 격리
  const engaged = await fetchInsightGroup(
    igId, ['accounts_engaged'], '&period=day&metric_type=total_value'
  );
  if (engaged.error) result.insightErrors.push(`engaged: ${engaged.error}`);
  result.accountsEngaged = engaged.values.accounts_engaged ?? 0;

  const profile = await fetchInsightGroup(
    igId, ['profile_views'], '&period=day&metric_type=total_value'
  );
  if (profile.error) result.insightErrors.push(`profile: ${profile.error}`);
  result.profileViews = profile.values.profile_views ?? 0;

  const follows = await fetchInsightGroup(
    igId, ['follows_and_unfollows'], '&period=day&metric_type=total_value'
  );
  if (follows.error) result.insightErrors.push(`follows: ${follows.error}`);
  result.followsNet = follows.values.follows_and_unfollows ?? 0;

  const views = await fetchInsightGroup(
    igId, ['views'], '&period=day&metric_type=total_value'
  );
  if (views.error) result.insightErrors.push(`views: ${views.error}`);
  result.views = views.values.views ?? 0;

  // 팔로워 수는 insights 가 아닌 계정 필드
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${igId}?fields=followers_count&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    result.followersCount = data.followers_count ?? 0;
  } catch (e) {
    result.insightErrors.push(`followers_count: ${e.message}`);
  }

  return result;
}

/* KST 기준 오늘 날짜 (YYYY-MM-DD) */
function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function processAccountDaily() {
  console.log('[Step 2] 계정 일일 지표 수집 중...');
  const igId = await findIgAccountId();
  if (!igId) return { ok: false };

  const metrics = await getAccountDailyMetrics(igId);
  if (metrics.insightErrors.length) {
    console.log(`[Step 2] 일부 지표 수집 실패: ${metrics.insightErrors.join(' | ')}`);
  }

  const today = todayKST();
  const properties = {
    '이름': { title: [{ type: 'text', text: { content: `일일 지표 ${today}` } }] },
    '날짜': { date: { start: today } },
    '유형': { select: { name: '일일' } },
    '도달': { number: metrics.reach },
    '조회수': { number: metrics.views },
    '프로필 방문': { number: metrics.profileViews },
    '팔로우 증감': { number: metrics.followsNet },
    '참여 계정 수': { number: metrics.accountsEngaged },
    '팔로워 수': { number: metrics.followersCount },
    '마지막 수집일': { date: { start: new Date().toISOString() } },
  };

  // 같은 날짜의 '일일' 행이 이미 있으면 갱신 (하루 여러 번 실행 대비)
  const existing = await queryDatabase(CONFIG.ACCOUNT_DB_ID, {
    and: [
      { property: '날짜', date: { equals: today } },
      { property: '유형', select: { equals: '일일' } },
    ],
  });

  if (existing.length > 0) {
    const upd = await updatePage(existing[0].id, properties);
    if (upd.isSchemaError) {
      console.error(`[Step 2] 속성/스키마 오류 (HTTP 400): ${upd.error || ''}`);
      return { ok: false };
    }
    console.log(`[Step 2] 오늘(${today}) 행 갱신 완료`);
  } else {
    const result = await createPage(CONFIG.ACCOUNT_DB_ID, properties);
    if (!result.success) {
      console.log(`[Step 2] 일일 지표 등록 실패: ${result.error || ''}`);
      return { ok: false };
    }
    console.log(`[Step 2] 오늘(${today}) 행 신규 등록 완료`);
  }
  return { ok: true };
}

/* ══════════════════════════ [Phase 3] 팔로워 demographic (주 1회) ══════════════════════════ */

async function fetchDemographic(igId, breakdown) {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${igId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${breakdown}&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) return { text: '', error: data.error.message };

    const results = data.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    const total = results.reduce((sum, r) => sum + (r.value || 0), 0) || 1;

    // 값 기준 내림차순, 상위 10개, "항목 값(비율%)" 형태로 직렬화
    const text = results
      .sort((a, b) => (b.value || 0) - (a.value || 0))
      .slice(0, 10)
      .map(r => {
        const label = (r.dimension_values || []).join('/');
        const pct = ((r.value / total) * 100).toFixed(1);
        return `${label} ${r.value}(${pct}%)`;
      })
      .join(', ');

    return { text, error: null };
  } catch (e) {
    return { text: '', error: e.message };
  }
}

async function processDemographics() {
  const dayOfWeekKST = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay(); // 1 = 월요일
  if (!CONFIG.FORCE_DEMOGRAPHICS && dayOfWeekKST !== 1) {
    console.log('[Step 3] 월요일이 아니므로 demographic 수집 건너뜀 (FORCE_DEMOGRAPHICS=1 로 강제 가능)');
    return { skipped: true };
  }

  console.log('[Step 3] 팔로워 demographic 수집 중... (팔로워 100명 미만이면 API가 거부합니다)');
  const igId = await findIgAccountId();
  if (!igId) return { ok: false };

  const [city, age, gender] = await Promise.all([
    fetchDemographic(igId, 'city'),
    fetchDemographic(igId, 'age'),
    fetchDemographic(igId, 'gender'),
  ]);
  for (const [name, r] of [['city', city], ['age', age], ['gender', gender]]) {
    if (r.error) console.log(`[Step 3] ${name} 수집 실패: ${r.error}`);
  }

  // 팔로워 수도 스냅샷에 같이 기록
  let followersCount = 0;
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${igId}?fields=followers_count&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    followersCount = (await res.json()).followers_count ?? 0;
  } catch (_) { /* 무시 */ }

  const today = todayKST();
  const properties = {
    '이름': { title: [{ type: 'text', text: { content: `주간 스냅샷 ${today}` } }] },
    '날짜': { date: { start: today } },
    '유형': { select: { name: '주간 스냅샷' } },
    '팔로워 수': { number: followersCount },
    '도시 분포': { rich_text: [{ type: 'text', text: { content: (city.text || '').slice(0, 2000) } }] },
    '연령 분포': { rich_text: [{ type: 'text', text: { content: (age.text || '').slice(0, 2000) } }] },
    '성별 분포': { rich_text: [{ type: 'text', text: { content: (gender.text || '').slice(0, 2000) } }] },
    '마지막 수집일': { date: { start: new Date().toISOString() } },
  };

  const existing = await queryDatabase(CONFIG.ACCOUNT_DB_ID, {
    and: [
      { property: '날짜', date: { equals: today } },
      { property: '유형', select: { equals: '주간 스냅샷' } },
    ],
  });

  if (existing.length > 0) {
    await updatePage(existing[0].id, properties);
    console.log(`[Step 3] 오늘(${today}) 스냅샷 갱신 완료`);
  } else {
    const result = await createPage(CONFIG.ACCOUNT_DB_ID, properties);
    if (!result.success) {
      console.log(`[Step 3] 스냅샷 등록 실패: ${result.error || ''}`);
      return { ok: false };
    }
    console.log(`[Step 3] 오늘(${today}) 스냅샷 신규 등록 완료`);
  }
  return { ok: true };
}

/* ─────────────────────────── 메인 ─────────────────────────── */
async function main() {
  console.log('=== Instagram Account Sync v1 Start ===');
  if (!CONFIG.NOTION_TOKEN || !CONFIG.INSTAGRAM_TOKEN) {
    console.error('필수 환경 변수가 누락되었습니다. (NOTION_TOKEN, INSTAGRAM_TOKEN)');
    process.exit(1);
  }
  try {
    const storyRes = await processStories();
    const dailyRes = await processAccountDaily();
    const demoRes = await processDemographics();
    console.log(
      `=== 완료 | 스토리 신규: ${storyRes.newStories} / 갱신: ${storyRes.updated}` +
      ` | 일일 지표: ${dailyRes.ok ? 'OK' : '실패'}` +
      ` | demographic: ${demoRes.skipped ? '건너뜀' : (demoRes.ok ? 'OK' : '실패')} ===`
    );
  } catch (err) {
    console.error('실행 중 에러 발생:', err);
    process.exit(1);
  }
}

main();
