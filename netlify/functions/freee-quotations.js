// freee請求書から、ガリレイ工事（取引先名に「ガリレイ」を含む）の見積書と明細を取得する
// ・明細はサーバー側に保存（キャッシュ）し、新しい見積・更新された見積だけを取りに行く
// ・1回の呼び出しは約7秒で区切り、残りがあれば remaining を返す（ブラウザ側で続きを呼ぶ）
const { getStore, connectLambda } = require('@netlify/blobs');

const API = 'https://api.freee.co.jp/iv';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const num = (v) => { const n = Number(String(v ?? '').replace(/[,¥\s]/g, '')); return Number.isFinite(n) ? n : 0; };

async function getToken(store) {
  let tk = await store.get('freee-token', { type: 'json' }).catch(() => null);
  if (!tk) return null;
  if (Date.now() < tk.expires_at - 5 * 60 * 1000) return tk;
  const redirectUri = process.env.FREEE_REDIRECT_URI || `${process.env.URL}/.netlify/functions/freee-callback`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.FREEE_CLIENT_ID,
      client_secret: process.env.FREEE_CLIENT_SECRET,
      refresh_token: tk.refresh_token,
      redirect_uri: redirectUri,
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) {
    // 同時に別の処理が更新していた場合は、保存し直された新しい通行証を使う
    const again = await store.get('freee-token', { type: 'json' }).catch(() => null);
    if (again && again.refresh_token !== tk.refresh_token && Date.now() < again.expires_at - 60 * 1000) return again;
    const err = new Error('freeeの連携が切れました。「freeeと連携」からもう一度許可してください。');
    err.reconnect = true;
    throw err;
  }
  tk = { ...tk, access_token: t.access_token, refresh_token: t.refresh_token || tk.refresh_token, expires_at: Date.now() + (t.expires_in || 21600) * 1000 };
  await store.setJSON('freee-token', tk);
  return tk;
}

async function api(tk, path, params = {}) {
  const qs = new URLSearchParams({ company_id: tk.company_id, ...params });
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}${path}?${qs}`, { headers: { Authorization: `Bearer ${tk.access_token}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (i + 1))); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`freee APIエラー（${res.status}）: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  }
  throw new Error('freee APIの呼び出し回数制限に達しました。しばらくしてから再度お試しください。');
}

// 項目名の違いに強い形で見積書を整える
function normalizeQuote(q) {
  const rawLines = q.lines || q.quotation_lines || q.items || q.quotation_contents || [];
  const lines = rawLines.map((l) => {
    const qty = num(l.quantity ?? l.qty);
    const unitPrice = num(l.unit_price);
    return {
      type: l.type || '',
      desc: String(l.description ?? l.name ?? l.item_name ?? '').trim(),
      qty,
      unit: l.unit || '',
      unitPrice,
      amount: num(l.amount_excluding_tax ?? l.amount ?? l.subtotal ?? 0) || qty * unitPrice,
    };
  }).filter((l) => l.desc || l.amount);
  let subtotal = num(q.amount_excluding_tax ?? q.sub_total ?? q.subtotal ?? q.total_amount_excluding_tax ?? 0);
  if (!subtotal) subtotal = lines.reduce((a, l) => a + (l.amount || 0), 0);
  return {
    id: q.id,
    number: q.quotation_number || '',
    subject: q.subject ?? q.title ?? '',
    date: q.quotation_date ?? q.issue_date ?? '',
    partner: q.partner_display_name || q.partner_name || '',
    subtotal,
    total: num(q.total_amount ?? q.amount_including_tax ?? 0),
    updated: q.updated_at || '',
    lines,
  };
}

exports.handler = async (event) => {
  const started = Date.now();
  try {
    connectLambda(event);
    const store = getStore('lm-settings');
    const tk = await getToken(store);
    if (!tk) return json(200, { connected: false });

    const params = event.queryStringParameters || {};
    // 取引先名にこれらの語を含む見積書を対象にする（全角・半角は区別しない）
    // 旧社名「福島工業」や「豊橋営業所」宛てで登録されている取引先も拾う
    const keywords = (process.env.FREEE_PARTNER_KEYWORDS || 'ガリレイ,福島工業,フクシマ,豊橋営業所')
      .split(',').map((k) => k.normalize('NFKC').trim()).filter(Boolean);
    const keywordsKey = keywords.join(',');
    const partnerText = (q) => Object.keys(q).filter((k) => k.startsWith('partner') && typeof q[k] === 'string').map((k) => q[k]).join(' ').normalize('NFKC');
    const partnerLabel = (q) => q.partner_display_name || q.partner_name || '';
    const since = new Date(); since.setFullYear(since.getFullYear() - 2);
    const sinceStr = since.toISOString().slice(0, 10);

    // ① 見積書の一覧（直近2年分）。分割読み込み中に毎回取り直さないよう10分間は保存した一覧を使う
    let listCache = await store.get('freee-list', { type: 'json' }).catch(() => null);
    let list = [], targets;
    if (!params.force && !params.debug && listCache && listCache.keywordsKey === keywordsKey && Date.now() - listCache.at < 10 * 60 * 1000) {
      targets = listCache.targets;
    } else {
      for (let offset = 0; offset < 10000; offset += 100) {
        const d = await api(tk, '/quotations', { limit: 100, offset, start_quotation_date: sinceStr });
        const arr = d.quotations || d.items || [];
        list.push(...arr);
        if (arr.length < 100) break;
      }
      targets = list.filter((q) => {
        const p = partnerText(q);
        return keywords.some((k) => p.includes(k)) && q.cancel_status !== 'canceled';
      }).map((q) => ({ id: q.id, updated_at: q.updated_at || '', partner: partnerLabel(q) }));
      await store.setJSON('freee-list', { at: Date.now(), targets, keywordsKey });
    }

    // 項目名の確認用（値は返さず、項目名だけ）
    if (params.debug) {
      const sample = targets[0] ? await api(tk, `/quotations/${targets[0].id}`) : null;
      const q = sample ? (sample.quotation || sample) : null;
      const lines = q ? (q.lines || q.quotation_lines || q.items || []) : [];
      return json(200, { listCount: list.length, sampleNormalized: q ? { lineCount: normalizeQuote(q).lines.length, subtotal: normalizeQuote(q).subtotal } : null, targetCount: targets.length, listKeys: list[0] ? Object.keys(list[0]) : [], detailKeys: q ? Object.keys(q) : [], lineKeys: lines[0] ? Object.keys(lines[0]) : [] });
    }

    // ② 明細：保存済みで更新が無いものは再取得しない
    const cache = (await store.get('freee-quotes', { type: 'json' }).catch(() => null)) || { byId: {} };
    const need = targets.filter((q) => { const c = cache.byId[q.id]; return !c || (q.updated_at && c.updated !== q.updated_at); });
    let fetched = 0;
    for (let i = 0; i < need.length; i += 6) {
      if (Date.now() - started > 7500) break; // 時間切れ前に区切る
      const chunk = need.slice(i, i + 6);
      const results = await Promise.all(chunk.map((q) => api(tk, `/quotations/${q.id}`).then((d) => d.quotation || d).catch(() => null)));
      results.forEach((r, j) => { if (r) { const n = normalizeQuote(r); n.updated = chunk[j].updated_at || n.updated; cache.byId[chunk[j].id] = n; fetched++; } });
    }
    const keep = new Set(targets.map((q) => String(q.id)));
    Object.keys(cache.byId).forEach((id) => { if (!keep.has(String(id))) delete cache.byId[id]; });
    cache.savedAt = new Date().toISOString();
    if (fetched) await store.setJSON('freee-quotes', cache);

    const quotes = Object.values(cache.byId).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // 取引先ごとの件数（対象に正しく含まれているか確認する用）
    const partnerCounts = {};
    targets.forEach((t) => { const k = t.partner || '（取引先名なし）'; partnerCounts[k] = (partnerCounts[k] || 0) + 1; });
    return json(200, { connected: true, quotes, partnerCounts, fetched, remaining: Math.max(0, need.length - fetched), total: targets.length, savedAt: cache.savedAt });
  } catch (err) {
    return json(err.reconnect ? 200 : 500, { connected: !err.reconnect, error: err.message || String(err) });
  }
};
