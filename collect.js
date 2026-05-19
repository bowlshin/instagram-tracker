/**
 * Instagram to Notion Sync Script (Open Source Ready)
 * 
 * 필수 환경 변수:
 * - NOTION_TOKEN: 노션 내부 통합 토큰
 * - NOTION_DB_ID: 노션 데이터베이스 ID
 * - INSTAGRAM_TOKEN: 페이스북/인스타그램 그래프 API 액세스 토큰
 * 
 * 선택 환경 변수:
 * - INSTAGRAM_ACCOUNT_ID: 자동으로 찾지 못할 경우를 대비한 수동 계정 ID
 */

const CONFIG = {
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  NOTION_DB_ID: process.env.NOTION_DB_ID,
  INSTAGRAM_TOKEN: process.env.INSTAGRAM_TOKEN,
  INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID, // 수동 설정 지원
  IG_BASE_URL: 'https://graph.facebook.com/v25.0/', 
};

let resolvedIgAccountId = null;

/**
 * 인스타그램 비즈니스 계정 ID를 찾는 로직 (다중 경로 지원 )
 */
async function findIgAccountId() {
  // 1. 환경 변수에 설정되어 있다면 즉시 반환 (가장 확실함)
  if (CONFIG.INSTAGRAM_ACCOUNT_ID) {
    return CONFIG.INSTAGRAM_ACCOUNT_ID;
  }

  if (resolvedIgAccountId) return resolvedIgAccountId;

  // 2. me/accounts에서 instagram_business_account 찾기
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
  } catch (e) { console.log('[IG Account] me/accounts 실패:', e.message); }

  // 3. me/media에서 게시물 하나 가져와서 owner 조회
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
  } catch (e) { console.log('[IG Account] me/media 실패:', e.message); }

  console.error('[IG Account] IG 계정 ID를 찾을 수 없습니다. 환경 변수에 INSTAGRAM_ACCOUNT_ID를 설정하세요.');
  return null;
}

/**
 * 노션 API 요청 헬퍼
 */
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
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, opts );
  const data = await res.json();
  if (!res.ok || data.object === 'error') {
    console.error(`[Notion Error] ${method} ${endpoint} → ${res.status}:`, JSON.stringify(data));
  }
  return data;
}

/**
 * 노션 DB 쿼리
 */
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

/**
 * 노션 페이지 업데이트
 */
async function updatePage(pageId, properties) {
  const result = await notionRequest(`pages/${pageId}`, 'PATCH', { properties });
  return { success: result.object !== 'error', error: result.message };
}

/**
 * 노션 페이지에 캡션(텍스트) 추가
 */
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

/**
 * 인스타그램 게시물 기본 정보 조회
 */
async function getMediaInfo(mediaId) {
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${mediaId}?fields=like_count,comments_count,media_type,permalink,timestamp,caption&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

/**
 * 인스타그램 인사이트 수집 (유형별 분기)
 */
async function getMediaInsights(mediaId, mediaType) {
  // 릴스/비디오는 plays, 나머지는 impressions 사용
  const isVideo = (mediaType === 'VIDEO' || mediaType === 'REEL');
  const isCarousel = (mediaType === 'CAROUSEL_ALBUM');
  
  // 수집할 지표 설정
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
      if (metric.name === 'saved') saved = metric.values[0]?.value || 0;
      if (metric.name === 'reach') reach = metric.values[0]?.value || 0;
      if (metric.name === 'plays' || metric.name === 'impressions') views = metric.values[0]?.value || 0;
    }
    return { saved, reach, views, insightError: null };
  } catch (e) { return { saved: 0, reach: 0, views: 0, insightError: e.message }; }
}

/**
 * 인스타그램 최근 게시물 목록 가져오기
 */
async function getRecentMedia() {
  const igId = await findIgAccountId();
  if (!igId) return [];
  try {
    const res = await fetch(
      `${CONFIG.IG_BASE_URL}${igId}/media?fields=id,permalink,caption,like_count,comments_count,timestamp,media_type&limit=50&access_token=${CONFIG.INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) { console.error('[Media Error]', data.error.message); return []; }
    return data.data || [];
  } catch (e) { console.error('[Media Exception]', e.message); return []; }
}

/**
 * URL에서 쇼트코드 추출 (매칭용)
 */
function getShortcode(url) {
  if (!url) return '';
  const clean = url.split('?')[0].replace(/\/$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1];
}

/**
 * [Phase 1] 신규 게시물 매칭 및 초기 데이터 수집
 */
async function processNewPosts() {
  console.log('[Step 1] 신규 게시물 확인 중...');
  const pages = await queryDatabase({
    and: [
      { property: '상태', status: { equals: '업로드 완료' } },
      { property: '트래킹 상태', select: { is_empty: true } },
      { property: '원본 URL', url: { is_not_empty: true } },
    ]
  });

  if (pages.length === 0) return { newPosts: 0 };
  const mediaList = await getRecentMedia();
  
  for (const page of pages) {
    const notionUrl = page.properties?.['원본 URL']?.url;
    const notionCode = getShortcode(notionUrl);
    const matched = mediaList.find(m => getShortcode(m.permalink) === notionCode);

    if (matched) {
      const insights = await getMediaInsights(matched.id, matched.media_type);
      await updatePage(page.id, {
        'Instagram ID': { rich_text: [{ type: 'text', text: { content: matched.id } }] },
        '조회수': { number: insights.views },
        '좋아요': { number: matched.like_count || 0 },
        '댓글': { number: matched.comments_count || 0 },
        '저장': { number: insights.saved },
        '도달': { number: insights.reach },
        '마지막 수집일': { date: { start: new Date().toISOString() } },
        '트래킹 상태': { select: { name: '트래킹중' } },
      });
      if (matched.caption) await appendCaptionBlock(page.id, matched.caption);
      console.log(`[New] 매칭 성공: ${notionCode}`);
    }
  }
  return { newPosts: pages.length };
}

/**
 * [Phase 2] 기존 트래킹 중인 게시물 업데이트 (56일 제한)
 */
async function updateExistingTracking() {
  console.log('[Step 2] 기존 트래킹 업데이트 중...');
  const pages = await queryDatabase({ property: '트래킹 상태', select: { equals: '트래킹중' } });
  const now = Date.now();

  for (const page of pages) {
    const dateStr = page.properties?.['날짜']?.date?.start;
    if (dateStr && (now - new Date(dateStr).getTime()) > (56 * 24 * 60 * 60 * 1000)) {
      await updatePage(page.id, { '트래킹 상태': { select: { name: '완료' } } });
      continue;
    }

    const instagramId = page.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content;
    if (!instagramId) continue;

    const mediaInfo = await getMediaInfo(instagramId);
    if (!mediaInfo || mediaInfo.error) continue;

    const insights = await getMediaInsights(instagramId, mediaInfo.media_type);
    await updatePage(page.id, {
      '조회수': { number: insights.views },
      '좋아요': { number: mediaInfo.like_count || 0 },
      '댓글': { number: mediaInfo.comments_count || 0 },
      '저장': { number: insights.saved },
      '도달': { number: insights.reach },
      '마지막 수집일': { date: { start: new Date().toISOString() } },
    });
  }
  return { tracked: pages.length };
}

/**
 * 메인 실행 함수
 */
async function main() {
  console.log('=== Instagram-Notion Sync Start ===');
  
  if (!CONFIG.NOTION_TOKEN || !CONFIG.NOTION_DB_ID || !CONFIG.INSTAGRAM_TOKEN || !CONFIG.INSTAGRAM_ACCOUNT_ID) {
    console.error('필수 환경 변수가 누락되었습니다.');
    process.exit(1);
  }

  try {
    const newRes = await processNewPosts();
    const trackRes = await updateExistingTracking();
    console.log(`=== 완료 | 신규 처리: ${newRes.newPosts} | 업데이트: ${trackRes.tracked} ===`);
  } catch (err) {
    console.error('실행 중 에러 발생:', err);
    process.exit(1);
  }
}

main();
