/**
 * Instagram to Notion Sync Script v2 (Auto-collect)
 *
 * 변경 사항:
 *   - 기존: 노션에 URL을 수동 입력해야 수집 가능
 *   - 개선: 인스타그램 API에서 게시물을 자동으로 가져와 노션 DB에 없으면 자동 생성
 *
 * 필수 환경 변수:
 *   - NOTION_TOKEN: 노션 내부 통합 토큰
 *   - NOTION_DB_ID: 노션 데이터베이스 ID
 *   - INSTAGRAM_TOKEN: 페이스북/인스타그램 그래프 API 액세스 토큰
 *
 * 선택 환경 변수:
 *   - INSTAGRAM_ACCOUNT_ID: 자동으로 찾지 못할 경우를 대비한 수동 계정 ID
 */

const CONFIG = {
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  NOTION_DB_ID: process.env.NOTION_DB_ID,
  INSTAGRAM_TOKEN: process.env.INSTAGRAM_TOKEN,
  INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID,
  IG_BASE_URL: 'https://graph.facebook.com/v25.0/',
};

let resolvedIgAccountId = null;

/**
 * 인스타그램 비즈니스 계정 ID를 찾는 로직 (다중 경로 지원)
 */
async function findIgAccountId() {
  if (CONFIG.INSTAGRAM_ACCOUNT_ID) {
    return CONFIG.INSTAGRAM_ACCOUNT_ID;
  }
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
  }
  return data;
}

/* 노션 DB 쿼리 (페이지네이션 지원) */
async function queryDatabase(filter) {
  let allResults = [];
  let startCursor = undefined;
  while (true) {
    const body = { filter };
    if (startCursor) body.start_cursor = startCursor;
    const data = await notionRequest(`databases/${CONFIG.NOTION_DB_ID}/query`, 'POST', body);
    if (data.object === 'error') return allResults;
    allResults = allResults.concat(data.results || []);
    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }
  return allResults;
}

/* 노션 페이지 업데이트 */
async function updatePage(pageId, properties) {
  const result = await notionRequest(`pages/${pageId}`, 'PATCH', { properties });
  return { success: result.object !== 'error', error: result.message };
}

/* 노션 페이지 생성 */
async function createPage(properties) {
  const result = await notionRequest('pages', 'POST', {
    parent: { database_id: CONFIG.NOTION_DB_ID },
    properties,
  });
  return { success: result.object !== 'error', id: result.id };
}

/* 노션 페이지에 캡션(텍스트) 추가 */
async function appendCaptionBlock(pageId, text) {
  if (!text) return;
  return notionRequest(`blocks/${pageId}/children`, 'PATCH', {
    children: [{
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }]
      }
    }]
  });
}

/* 인스타그램 게시물 기본 정보 조회 */
async function getMediaInfo(mediaId) {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${mediaId}?fields=like_count,comments_count,media_type,permalink,timestamp,caption&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

/* 인스타그램 인사이트 수집 (유형별 분기) */
async function getMediaInsights(mediaId, mediaType) {
  const isVideo = (mediaType === 'VIDEO' || mediaType === 'REEL');
  const isCarousel = (mediaType === 'CAROUSEL_ALBUM');

  let metrics = 'saved,reach';
  if (isVideo) metrics += ',plays';
  else if (!isCarousel) metrics += ',impressions';

  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${mediaId}/insights?metric=${metrics}&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) return { saved: 0, reach: 0, views: 0, insightError: data.error.message };

    let saved = 0, reach = 0, views = 0;
    for (const metric of (data.data || [])) {
      if (metric.name === 'saved') saved = metric.values?.[0]?.value || metric.value || 0;
      if (metric.name === 'reach') reach = metric.values?.[0]?.value || metric.value || 0;
      if (metric.name === 'plays' || metric.name === 'impressions')
        views = metric.values?.[0]?.value || metric.value || 0;
    }
    return { saved, reach, views, insightError: null };
  } catch (e) {
    return { saved: 0, reach: 0, views: 0, insightError: e.message };
  }
}

/* 인스타그램 최근 게시물 목록 가져오기 (페이지네이션 지원) */
async function getRecentMedia(limit = 50) {
  const igId = await findIgAccountId();
  if (!igId) return [];

  let allMedia = [];
  let url = `${CONFIG.IG_BASE_URL}${igId}/media?fields=id,permalink,caption,like_count,comments_count,timestamp,media_type&limit=50&access_token=${CONFIG.INSTAGRAM_TOKEN}`;

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

/**
 * [Phase 1 - 개선됨] 인스타그램 API에서 게시물을 자동 수집하여 신규 항목 생성
 *
 * 기존: 노션에 URL을 수동 입력 → 인스타그램과 매칭
 * 개선: 인스타그램 API에서 최신 게시물을 직접 가져와 → 노션 DB에 없으면 자동 생성
 */
async function processNewPosts() {
  console.log('[Step 1] 인스타그램에서 최신 게시물 자동 수집 중...');

  // 인스타그램 최신 게시물 가져오기
  const mediaList = await getRecentMedia(50);
  if (mediaList.length === 0) {
    console.log('[Step 1] 인스타그램 게시물을 가져오지 못했습니다.');
    return { newPosts: 0 };
  }
  console.log(`[Step 1] 인스타그램에서 ${mediaList.length}개 게시물 확인`);

  // 노션 DB에서 이미 등록된 Instagram ID 목록 조회
  const existingPages = await queryDatabase({
    property: 'Instagram ID',
    rich_text: { is_not_empty: true },
  });
  const existingIds = new Set(
    existingPages.map(p => p.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content).filter(Boolean)
  );
  console.log(`[Step 1] 노션 DB에 기존 등록된 게시물: ${existingIds.size}개`);

  const now = Date.now();
  const eightWeeksMs = 56 * 24 * 60 * 60 * 1000;
  let newCount = 0;

  for (const media of mediaList) {
    // 이미 등록된 게시물은 건너뜀
    if (existingIds.has(media.id)) continue;

    // 8주가 지난 게시물은 신규 등록하지 않음
    const postAge = now - new Date(media.timestamp).getTime();
    if (postAge > eightWeeksMs) {
      console.log(`[Step 1] 8주 초과 게시물 건너뜀: ${media.id}`);
      continue;
    }

    // 인사이트 수집
    const insights = await getMediaInsights(media.id, media.media_type);
    if (insights.insightError) {
      console.log(`[Step 1] 인사이트 수집 실패 (${media.id}): ${insights.insightError}`);
    }

    // 채널 분류
    const isVideo = media.media_type === 'VIDEO' || media.media_type === 'REEL';
    const channel = isVideo ? '릴스' : '피드/캐러셀';

    // 노션 DB에 새 항목 생성
    const properties = {
      '이름': {
        title: [{ type: 'text', text: { content: (media.caption || '(캡션 없음)').slice(0, 50) } }]
      },
      'Instagram ID': {
        rich_text: [{ type: 'text', text: { content: media.id } }]
      },
      '원본 URL': { url: media.permalink },
      '날짜': { date: { start: media.timestamp } },
      '채널': { select: { name: channel } },
      '상태': { status: { name: '업로드 완료' } },
      '트래킹 상태': { select: { name: '트래킹중' } },
      '조회수': { number: insights.views },
      '좋아요': { number: media.like_count || 0 },
      '댓글': { number: media.comments_count || 0 },
      '저장': { number: insights.saved },
      '도달': { number: insights.reach },
      '마지막 수집일': { date: { start: new Date().toISOString() } },
    };

    const result = await createPage(properties);
    if (result.success) {
      if (media.caption) await appendCaptionBlock(result.id, media.caption);
      console.log(`[Step 1] 신규 등록 완료: ${media.id} (${channel})`);
      newCount++;
    } else {
      console.log(`[Step 1] 신규 등록 실패: ${media.id}`);
    }

    // API 요청 제한 방지
    await new Promise(r => setTimeout(r, 300));
  }

  return { newPosts: newCount };
}

/**
 * [Phase 2] 기존 트래킹 중인 게시물 업데이트 (8주 = 56일 기준)
 * - 8주 이내: 최신 지표로 업데이트
 * - 8주 경과: '트래킹 종료'로 상태 변경 후 수집 중단
 */
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

    // 8주 경과 여부 확인
    if (dateStr && (now - new Date(dateStr).getTime()) > eightWeeksMs) {
      await updatePage(page.id, {
        '트래킹 상태': { select: { name: '트래킹 종료' } },
      });
      console.log(`[Step 2] 트래킹 종료 처리: ${page.id}`);
      expiredCount++;
      continue;
    }

    // Instagram ID로 최신 지표 수집
    const instagramId = page.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content;
    if (!instagramId) continue;

    const mediaInfo = await getMediaInfo(instagramId);
    if (!mediaInfo || mediaInfo.error) {
      console.log(`[Step 2] 미디어 정보 조회 실패: ${instagramId}`);
      continue;
    }

    const insights = await getMediaInsights(instagramId, mediaInfo.media_type);

    await updatePage(page.id, {
      '조회수': { number: insights.views },
      '좋아요': { number: mediaInfo.like_count || 0 },
      '댓글': { number: mediaInfo.comments_count || 0 },
      '저장': { number: insights.saved },
      '도달': { number: insights.reach },
      '마지막 수집일': { date: { start: new Date().toISOString() } },
    });
    console.log(`[Step 2] 업데이트 완료: ${instagramId}`);
    updatedCount++;

    await new Promise(r => setTimeout(r, 300));
  }

  return { tracked: updatedCount, expired: expiredCount };
}

/* 메인 실행 함수 */
async function main() {
  console.log('=== Instagram-Notion Sync v2 Start ===');

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
