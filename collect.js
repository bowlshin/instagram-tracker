const NOTION_TOKEN     = process.env.NOTION_TOKEN;
const INSTAGRAM_TOKEN  = process.env.INSTAGRAM_TOKEN;
const NOTION_DB_ID     = process.env.NOTION_DB_ID;
const IG_BASE_URL = 'https://graph.facebook.com/v25.0/';

let resolvedIgAccountId = null;

async function findIgAccountId() {
  if (resolvedIgAccountId) return resolvedIgAccountId;

  // 방법 1: me/accounts에서 instagram_business_account 찾기
  try {
    const res = await fetch(
      `${IG_BASE_URL}me/accounts?fields=instagram_business_account&access_token=${INSTAGRAM_TOKEN}`
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

  // 방법 2: me/media에서 게시물 하나 가져와서 owner 조회
  try {
    const res = await fetch(
      `${IG_BASE_URL}me/media?fields=id&limit=1&access_token=${INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      const mediaId = data.data[0].id;
      const ownerRes = await fetch(
        `${IG_BASE_URL}${mediaId}?fields=owner&access_token=${INSTAGRAM_TOKEN}`
      );
      const ownerData = await ownerRes.json();
      if (ownerData.owner && ownerData.owner.id) {
        resolvedIgAccountId = ownerData.owner.id;
        console.log('[IG Account] owner 조회로 찾음:', resolvedIgAccountId);
        return resolvedIgAccountId;
      }
    }
  } catch (e) { console.log('[IG Account] me/media 실패:', e.message); }

  // 방법 3: 노션 DB에서 기존 Instagram ID로 owner 조회
  try {
    const body = {
      filter: {
        property: 'Instagram ID',
        rich_text: { is_not_empty: true }
      },
      page_size: 1
    };
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const dbData = await dbRes.json();
    const existingId = dbData.results?.[0]?.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content;
    if (existingId) {
      const ownerRes = await fetch(
        `${IG_BASE_URL}${existingId}?fields=owner&access_token=${INSTAGRAM_TOKEN}`
      );
      const ownerData = await ownerRes.json();
      if (ownerData.owner && ownerData.owner.id) {
        resolvedIgAccountId = ownerData.owner.id;
        console.log('[IG Account] 노션 기존 데이터에서 찾음:', resolvedIgAccountId);
        return resolvedIgAccountId;
      }
    }
  } catch (e) { console.log('[IG Account] 노션 조회 실패:', e.message); }

  console.error('[IG Account] IG 계정 ID를 찾을 수 없습니다');
  return null;
}

async function notionRequest(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
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

async function queryDatabase(filter) {
  let allResults = [];
  let startCursor = undefined;
  while (true) {
    const body = { filter };
    if (startCursor) body.start_cursor = startCursor;
    const data = await notionRequest(`databases/${NOTION_DB_ID}/query`, 'POST', body);
    if (data.object === 'error') return allResults;
    allResults = allResults.concat(data.results || []);
    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }
  return allResults;
}

async function updatePage(pageId, properties) {
  const result = await notionRequest(`pages/${pageId}`, 'PATCH', { properties });
  if (result.object === 'error') return { success: false, error: result.message };
  return { success: true };
}

async function appendBlock(pageId, text) {
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

async function getMediaInfo(mediaId) {
  try {
    const res = await fetch(
      `${IG_BASE_URL}${mediaId}?fields=like_count,comments_count,media_type&access_token=${INSTAGRAM_TOKEN}`
    );
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function getMediaInsights(mediaId, mediaType) {
  const isVideo = (mediaType === 'VIDEO' || mediaType === 'REEL');
  const isCarousel = (mediaType === 'CAROUSEL_ALBUM');
  const metrics = isVideo ? 'saved,reach,views' : (isCarousel ? 'saved,reach' : 'saved,reach,impressions');
  try {
    const res = await fetch(
      `${IG_BASE_URL}${mediaId}/insights?metric=${metrics}&access_token=${INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) return { saved: 0, reach: 0, views: 0, insightError: data.error.message };
    let saved = 0, reach = 0, views = 0;
    for (const metric of (data.data || [])) {
      if (metric.name === 'saved') saved = metric.values[0]?.value || 0;
      if (metric.name === 'reach') reach = metric.values[0]?.value || 0;
      if (metric.name === 'views') views = metric.values[0]?.value || 0;
      if (metric.name === 'impressions') views = metric.values[0]?.value || 0;
    }
    return { saved, reach, views, insightError: null };
  } catch (e) { return { saved: 0, reach: 0, views: 0, insightError: e.message }; }
}

async function getRecentMedia() {
  const igId = await findIgAccountId();
  if (!igId) { console.error('[Error] IG 계정 ID를 찾을 수 없어 게시물 목록 조회 불가'); return []; }
  try {
    const res = await fetch(
      `${IG_BASE_URL}${igId}/media?fields=id,permalink,caption,like_count,comments_count,timestamp,media_type&limit=50&access_token=${INSTAGRAM_TOKEN}`
    );
    const data = await res.json();
    if (data.error) { console.error('[Media Error]', data.error.message); return []; }
    return data.data || [];
  } catch (e) { console.error('[Media Exception]', e.message); return []; }
}

function getShortcode(url) {
  if (!url) return '';
  const clean = url.split('?')[0].replace(/\/$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1];
}

async function processNewPosts() {
  const pages = await queryDatabase({
    and: [
      { property: '상태', status: { equals: '업로드 완료' } },
      { property: '트래킹 상태', select: { is_empty: true } },
      { property: '원본 URL', url: { is_not_empty: true } },
    ]
  });
  if (pages.length === 0) return { newPosts: 0, details: [] };
  const mediaList = await getRecentMedia();
  const results = [];
  for (const page of pages) {
    const pageId = page.id;
    const notionUrl = page.properties?.['원본 URL']?.url;
    if (!notionUrl) continue;
    const notionCode = getShortcode(notionUrl);
    let matched = null;
    for (const media of mediaList) {
      if (getShortcode(media.permalink) === notionCode) { matched = media; break; }
    }
    if (!matched) { results.push({ pageId, status: 'no_match_will_retry' }); continue; }
    const mediaType = matched.media_type || 'IMAGE';
    const insights = await getMediaInsights(matched.id, mediaType);
    const writeResult = await updatePage(pageId, {
      'Instagram ID': { rich_text: [{ type: 'text', text: { content: matched.id } }] },
      '조회수': { number: insights.views },
      '좋아요': { number: matched.like_count || 0 },
      '댓글': { number: matched.comments_count || 0 },
      '저장': { number: insights.saved },
      '도달': { number: insights.reach },
      '마지막 수집일': { date: { start: new Date().toISOString() } },
      '트래킹 상태': { select: { name: '트래킹중' } },
    });
    if (matched.caption) { await appendBlock(pageId, matched.caption); }
    results.push({
      pageId, instagramId: matched.id, mediaType,
      status: writeResult.success ? 'collected' : 'write_failed',
    });
  }
  return { newPosts: pages.length, details: results };
}

async function updateExistingTracking() {
  const pages = await queryDatabase({ property: '트래킹 상태', select: { equals: '트래킹중' } });
  if (pages.length === 0) return { tracked: 0, completed: 0, updated: 0, failed: 0, recovered: 0, details: [] };
  let completed = 0, updated = 0, failed = 0, recovered = 0;
  const results = [];
  const now = Date.now();
  let mediaList = null;
  for (const page of pages) {
    const pageId = page.id;
    const dateStr = page.properties?.['날짜']?.date?.start;
    if (dateStr) {
      const daysDiff = (now - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 56) {
        await updatePage(pageId, { '트래킹 상태': { select: { name: '완료' } } });
        completed++;
        results.push({ pageId, status: 'completed (56d+)' });
        continue;
      }
    }
    let instagramId = page.properties?.['Instagram ID']?.rich_text?.[0]?.text?.content;
    if (!instagramId) {
      const notionUrl = page.properties?.['원본 URL']?.url;
      if (!notionUrl) { results.push({ pageId, status: 'skipped (no id, no url)' }); continue; }
      if (!mediaList) mediaList = await getRecentMedia();
      const notionCode = getShortcode(notionUrl);
      let matched = null;
      for (const media of mediaList) {
        if (getShortcode(media.permalink) === notionCode) { matched = media; break; }
      }
      if (!matched) { results.push({ pageId, status: 'skipped (no match)' }); continue; }
      instagramId = matched.id;
      const mediaType = matched.media_type || 'IMAGE';
      const insights = await getMediaInsights(instagramId, mediaType);
      const wr = await updatePage(pageId, {
        'Instagram ID': { rich_text: [{ type: 'text', text: { content: instagramId } }] },
        '조회수': { number: insights.views },
        '좋아요': { number: matched.like_count || 0 },
        '댓글': { number: matched.comments_count || 0 },
        '저장': { number: insights.saved },
        '도달': { number: insights.reach },
        '마지막 수집일': { date: { start: new Date().toISOString() } },
      });
      if (matched.caption) await appendBlock(pageId, matched.caption);
      recovered++;
      results.push({ pageId, instagramId, status: wr.success ? 'recovered' : 'recovery_failed' });
      continue;
    }
    const mediaInfo = await getMediaInfo(instagramId);
    if (!mediaInfo || mediaInfo.error) {
      results.push({ pageId, instagramId, status: 'api_error', error: mediaInfo?.error?.message || 'unknown' });
      continue;
    }
    const mediaType = mediaInfo.media_type || 'IMAGE';
    const insights = await getMediaInsights(instagramId, mediaType);
    const writeResult = await updatePage(pageId, {
      '조회수': { number: insights.views },
      '좋아요': { number: mediaInfo.like_count || 0 },
      '댓글': { number: mediaInfo.comments_count || 0 },
      '저장': { number: insights.saved },
      '도달': { number: insights.reach },
      '마지막 수집일': { date: { start: new Date().toISOString() } },
    });
    if (writeResult.success) updated++; else failed++;
    results.push({
      pageId, instagramId, mediaType,
      status: writeResult.success ? 'updated' : 'write_failed',
    });
  }
  return { tracked: pages.length, completed, updated, failed, recovered, details: results };
}

async function main() {
  console.log('=== Instagram Tracking 시작 ===');
  console.log('시간:', new Date().toISOString());
  const missing = [];
  if (!NOTION_TOKEN) missing.push('NOTION_TOKEN');
  if (!INSTAGRAM_TOKEN) missing.push('INSTAGRAM_TOKEN');
  if (!NOTION_DB_ID) missing.push('NOTION_DB_ID');
  if (missing.length > 0) { console.error('누락된 환경변수:', missing.join(', ')); process.exit(1); }
  const newResult = await processNewPosts();
  console.log('신규:', JSON.stringify(newResult, null, 2));
  const trackResult = await updateExistingTracking();
  console.log('트래킹:', JSON.stringify(trackResult, null, 2));
  console.log(`\n=== 완료 | 신규: ${newResult.newPosts} | 업데이트: ${trackResult.updated} | 복구: ${trackResult.recovered} | 실패: ${trackResult.failed} ===`);
}

main().catch(err => { console.error('치명적 에러:', err); process.exit(1); });
