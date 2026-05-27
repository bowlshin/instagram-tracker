/**
 * Instagram to Notion Sync Script v3 (Auto-collect)
 *
 * v2 → v3 변경 사항:
 * - [핵심] 인사이트 호출을 지표 그룹별로 분할 → follows/profile_visits 가 거부돼도
 *   reach/views/saved/shares/watch_time 등 나머지 지표는 정상 수집됨
 *   (IG Insights API는 요청 지표 중 하나라도 미지원이면 호출 전체를 에러 처리하기 때문)
 * - [버그] updatePage 의 400 을 "다른 DB 페이지"로 오인하던 로직 수정
 *   → 404(페이지 없음)만 건너뛰고, 400(스키마/속성 오류)은 에러로 분명히 로그
 * - [정확도] 릴스 판별을 media_type 대신 media_product_type('REELS') 기준으로 변경
 *   → 일반 피드 영상(VIDEO)을 릴스로 오분류하지 않음
 *
 * Notion DB 속성 매핑:
 *   이름, Instagram ID, 원본 URL, 날짜, 채널, 트래킹 상태,
 *   조회수, 좋아요, 댓글, 저장, 도달, 공유, 팔로우, 프로필 방문,
 *   총 시청 시간(분), 평균 시청 시간(초), 총 반응 수, 마지막 수집일
 *
 * 필수 환경 변수: NOTION_TOKEN, NOTION_DB_ID, INSTAGRAM_TOKEN
 * 선택 환경 변수: INSTAGRAM_ACCOUNT_ID
 */

const CONFIG = {
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  NOTION_DB_ID: process.env.NOTION_DB_ID,
  INSTAGRAM_TOKEN: process.env.INSTAGRAM_TOKEN,
  INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID,
  IG_BASE_URL: 'https://graph.facebook.com/v25.0/',
};

let resolvedIgAccountId = null;

/* 인스타그램 비즈니스 계정 ID 탐색 (다중 경로) */
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

  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}me/media?fields=id&limit=1&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      const mediaId = data.data[0].id;
      const ownerRes = await fetch(
        `${CONFIG.IG_BASE_URL}${mediaId}?fields=owner&access_token=${CONFIG.INSTAGRAM_TOKEN}`
      );
      const ownerData = await ownerRes.json();
      if (ownerData.owner && ownerData.owner.id) {
        resolvedIgAccountId = ownerData.owner.id;
        console.log('[IG Account] owner 조회로 찾음:', resolvedIgAccountId);
        return resolvedIgAccountId;
      }
    }
  } catch (e) {
    console.log('[IG Account] me/media 실패:', e.message);
  }

  console.error('[IG Account] IG 계정 ID를 찾을 수 없습니다. 환경 변수에 INSTAGRAM_ACCOUNT_ID를 설정하세요.');
  return null;
}

/* 노션 API 요청 헬퍼 */
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

/* 노션 DB 쿼리 (페이지네이션) */
async function queryDatabase(filter) {
  let allResults = [];
  let startCursor = undefined;
  while (true) {
    const body = {};
    if (filter) body.filter = filter;
    if (startCursor) body.start_cursor = startCursor;

    const data = await notionRequest(`databases/${CONFIG.NOTION_DB_ID}/query`, 'POST', body);
    if (data.object === 'error') return allResults;

    allResults = allResults.concat(data.results || []);
    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }
  return allResults;
}

/* 노션 페이지 업데이트
 * - 404: 페이지가 삭제됐거나 통합 권한 밖 → 건너뛰어도 되는 케이스
 * - 400: 속성명/타입 불일치 등 "내 스크립트의 버그" → 조용히 넘기지 말고 에러로 노출
 */
async function updatePage(pageId, properties) {
  const result = await notionRequest(`pages/${pageId}`, 'PATCH', { properties });
  const success = result.object !== 'error';
  return {
    success,
    error: result.message,
    httpStatus: result._httpStatus,
    isMissingPage: result._httpStatus === 404,       // 진짜 건너뛰어도 되는 경우만
    isSchemaError: result._httpStatus === 400,        // 코드/스키마 문제 → 반드시 확인
  };
}

/* 노션 페이지 생성 */
async function createPage(properties) {
  const result = await notionRequest('pages', 'POST', {
    parent: { database_id: CONFIG.NOTION_DB_ID },
    properties,
  });
  return { success: result.object !== 'error', id: result.id, error: result.message };
}

/* 노션 페이지에 캡션 블록 추가 */
async function appendCaptionBlock(pageId, text) {
  if (!text) return;
  return notionRequest(`blocks/${pageId}/children`, 'PATCH', {
    children: [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] },
    }],
  });
}

/* 게시물 기본 정보 조회 (media_product_type 포함) */
async function getMediaInfo(mediaId) {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${mediaId}?fields=like_count,comments_count,media_type,media_product_type,permalink,timestamp,caption&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

/* 릴스 여부 판별: media_product_type === 'REELS' 가 정답.
 * (media_type 은 릴스도 VIDEO 로 반환하므로 일반 피드 영상과 구분 불가) */
function isReelMedia(media) {
  return media.media_product_type === 'REELS';
}

/* 인사이트 지표 그룹을 개별 호출로 가져와 병합.
 * 한 그룹이 실패해도 다른 그룹 값은 보존된다. */
async function fetchInsightGroup(mediaId, metrics) {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${mediaId}/insights?metric=${metrics.join(',')}&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) return { values: {}, error: data.error.message };

    const values = {};
    for (const metric of (data.data || [])) {
      values[metric.name] = metric.values?.[0]?.value ?? metric.value ?? 0;
    }
    return { values, error: null };
  } catch (e) {
    return { values: {}, error: e.message };
  }
}

/**
 * 인스타그램 인사이트 수집 (v22.0+ 호환, 그룹 분할 호출)
 *
 * 그룹 구성:
 *   core    : reach, saved, shares, total_interactions (+ 캐러셀 외에는 views)
 *   reels-A : ig_reels_avg_watch_time, ig_reels_video_view_total_time (릴스)
 *   reels-B : follows, profile_visits (릴스 — media product type에 따라 미지원일 수 있음)
 *
 * reels-B 가 (#100) 으로 거부돼도 core / reels-A 값은 그대로 살아남는다.
 */
async function getMediaInsights(media) {
  const isReel = isReelMedia(media);
  const isCarousel = media.media_type === 'CAROUSEL_ALBUM';

  const result = {
    saved: 0, reach: 0, views: 0, shares: 0,
    follows: 0, profileVisits: 0,
    avgWatchTimeSec: 0, totalWatchTimeMin: 0, totalInteractions: 0,
    insightErrors: [],
  };

  // --- core 그룹 ---
  const coreMetrics = ['reach', 'saved', 'shares', 'total_interactions'];
  if (!isCarousel) coreMetrics.push('views');
  const core = await fetchInsightGroup(media.id, coreMetrics);
  if (core.error) result.insightErrors.push(`core: ${core.error}`);
  result.reach = core.values.reach ?? 0;
  result.saved = core.values.saved ?? 0;
  result.shares = core.values.shares ?? 0;
  result.totalInteractions = core.values.total_interactions ?? 0;
  result.views = core.values.views ?? 0;

  // --- 릴스 전용 그룹 ---
  if (isReel) {
    const watch = await fetchInsightGroup(media.id, [
      'ig_reels_avg_watch_time',
      'ig_reels_video_view_total_time',
    ]);
    if (watch.error) result.insightErrors.push(`watch: ${watch.error}`);
    result.avgWatchTimeSec = Math.round((watch.values.ig_reels_avg_watch_time ?? 0) / 1000);
    result.totalWatchTimeMin = Math.round((watch.values.ig_reels_video_view_total_time ?? 0) / 60000);

    // follows / profile_visits 는 별도 그룹으로 격리 — 거부돼도 위 값들은 안전
    const acct = await fetchInsightGroup(media.id, ['follows', 'profile_visits']);
    if (acct.error) result.insightErrors.push(`acct: ${acct.error}`);
    result.follows = acct.values.follows ?? 0;
    result.profileVisits = acct.values.profile_visits ?? 0;
  }

  return result;
}

/* 최근 게시물 목록 (media_product_type 포함, 페이지네이션) */
async function getRecentMedia(limit = 50) {
  const igId = await findIgAccountId();
  if (!igId) return [];

  let allMedia = [];
  let url = `${CONFIG.IG_BASE_URL}${igId}/media?fields=id,permalink,caption,like_count,comments_count,timestamp,media_type,media_product_type&limit=50&access_token=${CONFIG.INSTAGRAM_TOKEN}`;

  while (allMedia.length < limit) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        console.error('[Media Error]', data.error.message);
        break;
      }
      allMedia = allMedia.concat(data.data || []);
      if (!data.paging?.next || allMedia.length >= limit) break;
      url = data.paging.next;
    } catch (e) {
      console.error('[Media Exception]', e.message);
      break;
    }
  }
  return allMedia.slice(0, limit);
}

/* 인사이트 → 노션 속성 변환. 릴스 전용 속성은 isReel일 때만 포함 */
function buildInsightProperties(insights, likeCount = 0, commentCount = 0, isReel = false) {
  const base = {
    '조회수': { number: insights.views || 0 },
    '좋아요': { number: likeCount || 0 },
    '댓글': { number: commentCount || 0 },
    '저장': { number: insights.saved || 0 },
    '도달': { number: insights.reach || 0 },
    '공유': { number: insights.shares || 0 },
    '총 반응 수': { number: insights.totalInteractions || 0 },
    '마지막 수집일': { date: { start: new Date().toISOString() } },
  };
  if (isReel) {
    base['팔로우'] = { number: insights.follows || 0 };
    base['프로필 방문'] = { number: insights.profileVisits || 0 };
    base['평균 시청 시간(초)'] = { number: insights.avgWatchTimeSec || 0 };
    base['총 시청 시간(분)'] = { number: insights.totalWatchTimeMin || 0 };
  }
  return base;
}

/* [Phase 1] 신규 게시물 자동 등록 */
async function processNewPosts() {
  console.log('[Step 1] 인스타그램에서 최신 게시물 자동 수집 중...');
  const mediaList = await getRecentMedia(50);
  if (mediaList.length === 0) {
    console.log('[Step 1] 인스타그램 게시물을 가져오지 못했습니다.');
    return { newPosts: 0 };
  }
  console.log(`[Step 1] 인스타그램에서 ${mediaList.length}개 게시물 확인`);

  const existingPages = await queryDatabase({
    property: 'Instagram ID',
    rich_text: { is_not_empty: true },
  });
  const existingIds = new Set(
    existingPages
      .map(p => p.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content)
      .filter(Boolean)
  );
  console.log(`[Step 1] 노션 DB에 기존 등록된 게시물: ${existingIds.size}개`);

  const now = Date.now();
  const eightWeeksMs = 56 * 24 * 60 * 60 * 1000;
  let newCount = 0;

  for (const media of mediaList) {
    if (existingIds.has(media.id)) continue;

    const postAge = now - new Date(media.timestamp).getTime();
    if (postAge > eightWeeksMs) {
      console.log(`[Step 1] 8주 초과 게시물 건너뜀: ${media.id}`);
      continue;
    }

    const insights = await getMediaInsights(media);
    if (insights.insightErrors.length) {
      console.log(`[Step 1] 일부 인사이트 수집 실패 (${media.id}): ${insights.insightErrors.join(' | ')}`);
    }

    const isReel = isReelMedia(media);
    const properties = {
      '이름': { title: [{ type: 'text', text: { content: (media.caption || '(캡션 없음)').slice(0, 50) } }] },
      'Instagram ID': { rich_text: [{ type: 'text', text: { content: media.id } }] },
      '원본 URL': { url: media.permalink },
      '날짜': { date: { start: media.timestamp } },
      '채널': { select: { name: isReel ? '릴스' : '피드/캐러셀' } },
      '트래킹 상태': { select: { name: '트래킹중' } },
      ...buildInsightProperties(insights, media.like_count, media.comments_count, isReel),
    };

    const result = await createPage(properties);
    if (result.success) {
      if (media.caption) await appendCaptionBlock(result.id, media.caption);
      console.log(`[Step 1] 신규 등록 완료: ${media.id} (${isReel ? '릴스' : '피드/캐러셀'})`);
      newCount++;
    } else {
      console.log(`[Step 1] 신규 등록 실패: ${media.id} → ${result.error || ''}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { newPosts: newCount };
}

/* [Phase 2] 기존 트래킹 게시물 업데이트 (8주 기준) */
async function updateExistingTracking() {
  console.log('[Step 2] 기존 트래킹 게시물 업데이트 중...');
  const pages = await queryDatabase({
    property: '트래킹 상태',
    select: { equals: '트래킹중' },
  });

  const now = Date.now();
  const eightWeeksMs = 56 * 24 * 60 * 60 * 1000;
  let updatedCount = 0;
  let expiredCount = 0;

  for (const page of pages) {
    const dateStr = page.properties?.['날짜']?.date?.start;

    if (dateStr && (now - new Date(dateStr).getTime()) > eightWeeksMs) {
      await updatePage(page.id, { '트래킹 상태': { select: { name: '트래킹 종료' } } });
      console.log(`[Step 2] 트래킹 종료 처리: ${page.id}`);
      expiredCount++;
      continue;
    }

    const instagramId = page.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content;
    if (!instagramId) continue;

    const mediaInfo = await getMediaInfo(instagramId);
    if (!mediaInfo || mediaInfo.error) {
      console.log(`[Step 2] 미디어 정보 조회 실패: ${instagramId}`);
      continue;
    }

    const insights = await getMediaInsights(mediaInfo);
    if (insights.insightErrors.length) {
      console.log(`[Step 2] 일부 인사이트 수집 실패 (${instagramId}): ${insights.insightErrors.join(' | ')}`);
    }

    const isReel = isReelMedia(mediaInfo);
    const updateResult = await updatePage(
      page.id,
      buildInsightProperties(insights, mediaInfo.like_count, mediaInfo.comments_count, isReel)
    );

    if (updateResult.isMissingPage) {
      console.log(`[Step 2] 삭제됐거나 접근 불가한 페이지 건너뜀 (HTTP 404): ${page.id}`);
      continue;
    }
    if (updateResult.isSchemaError) {
      // 400 은 "다른 DB 페이지"가 아니라 속성명/타입 오류일 가능성이 큼 → 분명히 노출
      console.error(`[Step 2] 속성/스키마 오류 (HTTP 400): ${page.id} → ${updateResult.error || ''}`);
      continue;
    }

    console.log(`[Step 2] 업데이트 완료: ${instagramId}`);
    updatedCount++;
    await new Promise(r => setTimeout(r, 300));
  }
  return { tracked: updatedCount, expired: expiredCount };
}

/* 메인 */
async function main() {
  console.log('=== Instagram-Notion Sync v3 Start ===');
  if (!CONFIG.NOTION_TOKEN || !CONFIG.NOTION_DB_ID || !CONFIG.INSTAGRAM_TOKEN) {
    console.error('필수 환경 변수가 누락되었습니다. (NOTION_TOKEN, NOTION_DB_ID, INSTAGRAM_TOKEN)');
    process.exit(1);
  }
  try {
    const newRes = await processNewPosts();
    const trackRes = await updateExistingTracking();
    console.log(`=== 완료 | 신규 등록: ${newRes.newPosts} | 업데이트: ${trackRes.tracked} | 트래킹 종료: ${trackRes.expired} ===`);
  } catch (err) {
    console.error('실행 중 에러 발생:', err);
    process.exit(1);
  }
}

main();
