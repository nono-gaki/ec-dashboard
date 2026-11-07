// freee連携の開始：管理パスワードを確認してから、freeeのログイン（許可）画面へ移動する
const { getStore, connectLambda } = require('@netlify/blobs');
const crypto = require('crypto');

const page = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>freee連携</title><body style="font-family:sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1A2332">${body}</body></html>`,
});

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod === 'GET') {
    return page(`<h3>freee請求書と連携</h3>
<p style="font-size:14px">管理パスワードを入力すると、freeeのログイン画面に移動します。ログイン後、事業所「株式会社LIFEMARK'S」を選んで許可してください。</p>
<form method="post"><input type="password" name="password" placeholder="管理パスワード" style="width:100%;padding:10px;font-size:15px;box-sizing:border-box">
<button style="margin-top:12px;padding:10px 18px;font-size:15px;background:#2563EB;color:#fff;border:none;border-radius:6px">freeeと連携する</button></form>`);
  }
  if (!process.env.ADMIN_PASSWORD) return page('<p>Netlifyの環境変数 ADMIN_PASSWORD が未設定です。</p>');
  if (!process.env.FREEE_CLIENT_ID || !process.env.FREEE_CLIENT_SECRET) return page('<p>Netlifyの環境変数 FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が未設定です。</p>');

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '');
  const password = new URLSearchParams(raw).get('password');
  if (password !== process.env.ADMIN_PASSWORD) {
    await new Promise((r) => setTimeout(r, 1500)); // 総当たり対策
    return page('<p>管理パスワードが違います。</p><a href="">戻る</a>');
  }

  // なりすまし防止用の合言葉（state）を保存してから freee へ
  const state = crypto.randomBytes(16).toString('hex');
  await getStore('lm-settings').setJSON('freee-state', { state, at: Date.now() });
  const redirectUri = process.env.FREEE_REDIRECT_URI || `${process.env.URL}/.netlify/functions/freee-callback`;
  const url = 'https://accounts.secure.freee.co.jp/public_api/authorize?' + new URLSearchParams({
    client_id: process.env.FREEE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    prompt: 'select_company',
    state,
  });
  return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '' };
};
