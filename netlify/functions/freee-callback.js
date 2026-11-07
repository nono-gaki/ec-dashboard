// freeeで許可した後に戻ってくる先：通行証（トークン）を受け取ってサーバー側に保存する
const { getStore, connectLambda } = require('@netlify/blobs');

const page = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>freee連携</title><body style="font-family:sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1A2332">${body}</body></html>`,
});

exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore('lm-settings');
  const { code, state, error } = event.queryStringParameters || {};
  if (error) return page(`<p>freeeでの許可がキャンセルされました（${error}）。</p>`);

  const saved = await store.get('freee-state', { type: 'json' }).catch(() => null);
  if (!saved || !state || saved.state !== state || Date.now() - saved.at > 10 * 60 * 1000) {
    return page('<p>連携の有効時間が切れたか、不正なアクセスです。ダッシュボードからもう一度「freeeと連携」を行ってください。</p>');
  }

  const redirectUri = process.env.FREEE_REDIRECT_URI || `${process.env.URL}/.netlify/functions/freee-callback`;
  const res = await fetch('https://accounts.secure.freee.co.jp/public_api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.FREEE_CLIENT_ID,
      client_secret: process.env.FREEE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) {
    return page(`<p>freeeからの通行証の取得に失敗しました（${res.status}）。</p><pre style="font-size:11px;white-space:pre-wrap">${(t.error_description || t.error || '').toString().slice(0, 300)}</pre>`);
  }

  // 事業所ID：通常はトークンの応答に入っている。無ければ事業所一覧から取得
  let companyId = t.company_id;
  if (!companyId) {
    const cr = await fetch('https://api.freee.co.jp/api/1/companies', { headers: { Authorization: `Bearer ${t.access_token}` } });
    const cj = await cr.json().catch(() => ({}));
    companyId = cj.companies && cj.companies[0] && cj.companies[0].id;
  }

  await store.setJSON('freee-token', {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in || 21600) * 1000,
    company_id: companyId,
    connected_at: new Date().toISOString(),
  });
  await store.delete('freee-state');
  return page(`<h3>✓ freeeとの連携が完了しました</h3><p style="font-size:14px">このページを閉じて、ダッシュボードの「概算見積もり」を開き直してください。</p><a href="/">ダッシュボードへ戻る</a>`);
};
