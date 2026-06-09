// ============================================================
//  富士見文化室 — Google Apps Script バックエンド
//
//  【セットアップ手順】
//  1. Google スプレッドシートを新規作成し SPREADSHEET_ID を設定
//  2. PayPay Developer (https://developer.paypay.ne.jp/) でアカウント作成
//     → API Key / API Secret / Merchant ID を取得して下記に設定
//  3. まずテスト環境 (PAYPAY_SANDBOX = true) で動作確認
//  4. Apps Script エディタで「デプロイ」→「新しいデプロイ」
//     種類: ウェブアプリ / 実行: 自分 / アクセス: 全員
//  5. 発行された URL を LP の APPS_SCRIPT_URL に貼る
//  6. 発行された URL を PayPay Developer の Webhook URL にも設定する
// ============================================================

var SPREADSHEET_ID    = 'YOUR_SPREADSHEET_ID'; // ← 変更必須
var ADMIN_KEY         = 'fujimi-admin-2025';   // ← 好きなパスワードに変更

// ── PayPay API 設定 ──────────────────────────────────────────
var PAYPAY_API_KEY     = 'YOUR_PAYPAY_API_KEY';     // ← Developer サイトで取得
var PAYPAY_API_SECRET  = 'YOUR_PAYPAY_API_SECRET';  // ← Developer サイトで取得
var PAYPAY_MERCHANT_ID = 'YOUR_PAYPAY_MERCHANT_ID'; // ← Developer サイトで取得
var PAYPAY_SANDBOX     = true; // テスト中は true、本番運用時に false へ

var PAYPAY_BASE = PAYPAY_SANDBOX
  ? 'https://stg-api.paypay.ne.jp'
  : 'https://api.paypay.ne.jp';

var NAMING_AMOUNT = 500; // 円

// ───────── エントリポイント ─────────

function doGet(e) {
  var type = e.parameter.type || '';
  var key  = e.parameter.key  || '';

  if (type === 'news')          return jsonRes(getNews());
  if (type === 'auth')          return jsonRes({ ok: key === ADMIN_KEY });
  if (type === 'namings'  && key === ADMIN_KEY) return jsonRes(getNamings());
  if (type === 'payStatus')     return jsonRes(getPayStatus(e.parameter.orderId || ''));

  return jsonRes({ error: 'not_found' });
}

function doPost(e) {
  // PayPay Webhook（Content-Type: application/json で直接 POST）
  if (e.postData && e.postData.type === 'application/json') {
    return handlePayPayWebhook(e.postData.contents);
  }

  var payload;
  try {
    var raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    payload = JSON.parse(raw);
  } catch (_) {
    return jsonRes({ error: 'bad_request' });
  }

  var type = payload.type     || '';
  var key  = payload.adminKey || '';

  if (type === 'naming')     return jsonRes(saveNaming(payload));

  if (key !== ADMIN_KEY)     return jsonRes({ error: 'unauthorized' });
  if (type === 'addNews')    return jsonRes(addNews(payload));
  if (type === 'updateNews') return jsonRes(updateNews(payload));
  if (type === 'deleteNews') return jsonRes(deleteNews(payload));

  return jsonRes({ error: 'not_found' });
}

// ───────── PayPay: QR 作成 ─────────

function createPayPayQR(orderId, description) {
  var path = '/v1/qrcodes';
  var body = JSON.stringify({
    merchantPaymentId: orderId,
    amount:            { amount: NAMING_AMOUNT, currency: 'JPY' },
    codeType:          'ORDER_QR',
    orderDescription:  description,
    isAuthorization:   false
  });

  var headers = buildPayPayAuthHeader('POST', path, body);

  try {
    var res = UrlFetchApp.fetch(PAYPAY_BASE + path, {
      method:            'POST',
      headers:           headers,
      payload:           body,
      muteHttpExceptions: true
    });
    var json = JSON.parse(res.getContentText());
    if (json.resultInfo && json.resultInfo.code === 'SUCCESS') {
      return {
        success:  true,
        url:      json.data.url,
        deeplink: json.data.deeplink,
        codeId:   json.data.codeId
      };
    }
    Logger.log('PayPay QR error: ' + res.getContentText());
    return { success: false, error: json.resultInfo && json.resultInfo.message };
  } catch (err) {
    Logger.log('PayPay fetch error: ' + err);
    return { success: false, error: String(err) };
  }
}

// ───────── PayPay: HMAC 認証ヘッダー生成 ─────────

function buildPayPayAuthHeader(method, path, body) {
  var epoch = Math.floor(Date.now() / 1000);
  var nonce = Utilities.getUuid().replace(/-/g, '').substring(0, 8);

  var hashBody = 'null';
  if (body) {
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      body,
      Utilities.Charset.UTF_8
    );
    hashBody = Utilities.base64Encode(digest);
  }

  // PayPay HMAC メッセージ形式
  var message = [method.toUpperCase(), String(epoch), nonce, path, hashBody].join('\n');

  var sigBytes = Utilities.computeHmacSha256Signature(
    message,
    PAYPAY_API_SECRET,
    Utilities.Charset.UTF_8
  );
  var sig = Utilities.base64Encode(sigBytes);

  return {
    'Authorization': [
      'hmac OPA-Auth-v1-HMAC-SHA256',
      PAYPAY_API_KEY + ':' + epoch + ':' + nonce + ':' + hashBody + ':' + sig
    ].join(' '),
    'X-ASSUME-MERCHANT': PAYPAY_MERCHANT_ID,
    'Content-Type':      'application/json; charset=UTF-8'
  };
}

// ───────── PayPay: Webhook 受信 ─────────

function handlePayPayWebhook(contents) {
  try {
    var data = JSON.parse(contents);
    // PayPay は { notification_type, data: { merchantPaymentId, status } } を送る
    var inner = data.data || data;
    var orderId = inner.merchantPaymentId || '';
    var status  = inner.status || '';

    if (orderId && status === 'COMPLETED') {
      updateNamingPayStatus(orderId, 'paid');
    }
  } catch (err) {
    Logger.log('Webhook parse error: ' + err);
  }
  // PayPay には 200 を返す
  return ContentService.createTextOutput('OK');
}

// ───────── PayPay: 支払いステータス確認（ポーリング用）─────────

function getPayStatus(orderId) {
  if (!orderId) return { error: 'no_orderId' };

  // まずシートのキャッシュを確認（Webhook 受信済みなら即返す）
  var sheet   = getSheet('namings', NAMING_HEADERS);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol   = headers.indexOf('orderId');
  var stCol   = headers.indexOf('payStatus');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === orderId) {
      if (String(data[i][stCol]) === 'paid') return { status: 'paid' };
      break;
    }
  }

  // PayPay API に直接問い合わせ（念のため）
  var path = '/v1/qrcodes/' + encodeURIComponent(orderId) + '/payment/details';
  var headers2 = buildPayPayAuthHeader('GET', path, null);
  try {
    var res  = UrlFetchApp.fetch(PAYPAY_BASE + path, {
      method: 'GET', headers: headers2, muteHttpExceptions: true
    });
    var json = JSON.parse(res.getContentText());
    if (json.data && json.data.status === 'COMPLETED') {
      updateNamingPayStatus(orderId, 'paid');
      return { status: 'paid' };
    }
  } catch (err) {
    Logger.log('getPayStatus error: ' + err);
  }
  return { status: 'pending' };
}

// ───────── ユーティリティ ─────────

function jsonRes(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name, headers) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) sheet.appendRow(headers);
  }
  return sheet;
}

function rowToObj(headers, row) {
  var obj = {};
  headers.forEach(function(h, i) { obj[h] = row[i] != null ? String(row[i]) : ''; });
  return obj;
}

// ───────── NEWS ─────────

function getNews() {
  var sheet = getSheet('news', ['id', 'date', 'tag', 'text', 'createdAt']);
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  return data.slice(1)
    .map(function(r) { return rowToObj(headers, r); })
    .filter(function(r) { return r.text; })
    .sort(function(a, b) { return b.date > a.date ? 1 : -1; });
}

function addNews(d) {
  var sheet = getSheet('news', ['id', 'date', 'tag', 'text', 'createdAt']);
  var id    = String(Date.now());
  sheet.appendRow([id, d.date || '', d.tag || 'info', d.text || '', new Date().toISOString()]);
  return { success: true, id: id };
}

function updateNews(d) {
  var sheet   = getSheet('news', ['id', 'date', 'tag', 'text', 'createdAt']);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol   = headers.indexOf('id');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(d.id)) {
      sheet.getRange(i+1, headers.indexOf('date')+1).setValue(d.date || '');
      sheet.getRange(i+1, headers.indexOf('tag') +1).setValue(d.tag  || 'info');
      sheet.getRange(i+1, headers.indexOf('text')+1).setValue(d.text || '');
      return { success: true };
    }
  }
  return { error: 'not_found' };
}

function deleteNews(d) {
  var sheet   = getSheet('news', ['id', 'date', 'tag', 'text', 'createdAt']);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol   = headers.indexOf('id');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(d.id)) {
      sheet.deleteRow(i+1);
      return { success: true };
    }
  }
  return { error: 'not_found' };
}

// ───────── NAMINGS ─────────

var NAMING_HEADERS = [
  'orderId', 'workId', 'workNo', 'genre',
  'namingTitle', 'person', 'email', 'comment',
  'submittedAt', 'payStatus', 'payppayUrl'
];

function saveNaming(d) {
  var orderId = 'naming_' + Date.now();
  var desc    = '作品' + (d.workNo || d.workId || '') + ' 名前申込：' + (d.namingTitle || '');

  // 1. PayPay QR を生成
  var pay = createPayPayQR(orderId, desc);

  // 2. スプレッドシートに保存（支払い前は pending）
  var sheet = getSheet('namings', NAMING_HEADERS);
  sheet.appendRow([
    orderId,
    d.workId       || '',
    d.workNo       || '',
    d.genre        || '',
    d.namingTitle  || '',
    d.person       || '',
    d.email        || '',
    d.comment      || '',
    new Date().toISOString(),
    'pending',
    pay.url        || ''
  ]);

  if (!pay.success) {
    return { success: false, error: 'paypay_error', detail: pay.error };
  }

  return {
    success:  true,
    orderId:  orderId,
    payUrl:   pay.url,
    deeplink: pay.deeplink
  };
}

function getNamings() {
  var sheet   = getSheet('namings', NAMING_HEADERS);
  var data    = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  return data.slice(1).map(function(r) { return rowToObj(headers, r); });
}

function updateNamingPayStatus(orderId, status) {
  var sheet   = getSheet('namings', NAMING_HEADERS);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol   = headers.indexOf('orderId');
  var stCol   = headers.indexOf('payStatus');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === orderId) {
      sheet.getRange(i + 1, stCol + 1).setValue(status);
      return true;
    }
  }
  return false;
}
