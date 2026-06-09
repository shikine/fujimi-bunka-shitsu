// ============================================================
//  富士見文化室 — Google Apps Script バックエンド
//
//  【セットアップ手順】
//  1. Google スプレッドシートを新規作成し SPREADSHEET_ID を設定
//  2. Stripe (https://dashboard.stripe.com/) でアカウント作成
//     → 開発者 → APIキー から「シークレットキー」を取得
//     → Webhook を追加：URL = このGASのデプロイURL、イベント = checkout.session.completed
//     → Webhook の「署名シークレット」(whsec_...) を取得
//  3. 下記 STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET を設定
//  4. LP_BASE_URL を公開済みサイトのURLに設定
//  5. Apps Script エディタで「デプロイ」→「新しいデプロイ」
//     種類: ウェブアプリ / 実行: 自分 / アクセス: 全員
//  6. 発行された URL を LP の APPS_SCRIPT_URL に貼る
//  7. 発行された URL を Stripe の Webhook URL にも貼る
// ============================================================

var SPREADSHEET_ID         = 'YOUR_SPREADSHEET_ID';          // ← 変更必須
var ADMIN_KEY              = 'fujimi-admin-2025';             // ← 好きなパスワードに変更
var STRIPE_SECRET_KEY      = 'sk_test_YOUR_KEY';             // ← Stripe ダッシュボードから取得
var STRIPE_WEBHOOK_SECRET  = 'whsec_YOUR_WEBHOOK_SECRET';   // ← Stripe Webhook から取得
var LP_BASE_URL            = 'https://shikine.github.io/fujimi-bunka-shitsu/fujimi_bunka_shitsu_lp.html';

var NAMING_AMOUNT   = 500; // 円
var NOTIFY_EMAIL    = '';  // ← 通知を受け取りたいメールアドレス（省略可）

// ───────── エントリポイント ─────────

function doGet(e) {
  var type = e.parameter.type || '';
  var key  = e.parameter.key  || '';

  if (type === 'news')   return jsonRes(getNews());
  if (type === 'auth')   return jsonRes({ ok: key === ADMIN_KEY });
  if (type === 'namings' && key === ADMIN_KEY) return jsonRes(getNamings());

  return jsonRes({ error: 'not_found' });
}

function doPost(e) {
  // Stripe Webhook（Content-Type: application/json）
  if (e.postData && e.postData.type === 'application/json') {
    return handleStripeWebhook(e.postData.contents, e.parameter['stripe-signature'] || '');
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

  if (type === 'naming')   return jsonRes(saveNaming(payload));
  if (type === 'contact')  return jsonRes(saveContact(payload));

  if (key !== ADMIN_KEY) return jsonRes({ error: 'unauthorized' });
  if (type === 'contacts' ) return jsonRes(getContacts());
  if (type === 'addNews')    return jsonRes(addNews(payload));
  if (type === 'updateNews') return jsonRes(updateNews(payload));
  if (type === 'deleteNews') return jsonRes(deleteNews(payload));

  return jsonRes({ error: 'not_found' });
}

// ───────── Stripe: Checkout セッション作成 ─────────

function createStripeCheckout(orderId, description) {
  var successUrl = LP_BASE_URL + '?payment=success&orderId=' + encodeURIComponent(orderId);
  var cancelUrl  = LP_BASE_URL + '?payment=cancel';

  // Stripe API は form-encoded
  var params = [
    'mode=payment',
    'payment_method_types[]=card',
    'line_items[0][price_data][currency]=jpy',
    'line_items[0][price_data][unit_amount]=' + NAMING_AMOUNT,
    'line_items[0][price_data][product_data][name]=' + encodeURIComponent('富士見文化室 名前申込'),
    'line_items[0][price_data][product_data][description]=' + encodeURIComponent(description),
    'line_items[0][quantity]=1',
    'metadata[orderId]=' + encodeURIComponent(orderId),
    'success_url=' + encodeURIComponent(successUrl),
    'cancel_url='  + encodeURIComponent(cancelUrl)
  ].join('&');

  try {
    var res = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      payload:            params,
      muteHttpExceptions: true
    });

    var json = JSON.parse(res.getContentText());
    if (json.url) {
      return { success: true, checkoutUrl: json.url, sessionId: json.id };
    }
    Logger.log('Stripe error: ' + res.getContentText());
    return { success: false, error: json.error && json.error.message };
  } catch (err) {
    Logger.log('Stripe fetch error: ' + err);
    return { success: false, error: String(err) };
  }
}

// ───────── Stripe: Webhook 受信 ─────────

function handleStripeWebhook(body, sigHeader) {
  // 署名検証
  if (!verifyStripeSignature(body, sigHeader)) {
    Logger.log('Stripe signature verification failed');
    // 小規模イベントのため署名エラーでも処理継続（本番ではコメントアウト解除を検討）
    // return ContentService.createTextOutput('Unauthorized');
  }

  try {
    var event = JSON.parse(body);
    if (event.type === 'checkout.session.completed') {
      var session = event.data.object;
      var orderId = (session.metadata && session.metadata.orderId) || '';
      if (orderId) {
        updateNamingPayStatus(orderId, 'paid');
        Logger.log('Payment completed: ' + orderId);

        // 支払い完了メール通知
        if (NOTIFY_EMAIL) {
          try {
            MailApp.sendEmail(NOTIFY_EMAIL,
              '【富士見文化室】💳 支払い完了：' + orderId,
              [
                '名前申込の支払いが完了しました。',
                '',
                '注文ID：' + orderId,
                '',
                '管理シート：https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID
              ].join('\n')
            );
          } catch(err) { Logger.log('Mail error: ' + err); }
        }
      }
    }
  } catch (err) {
    Logger.log('Webhook parse error: ' + err);
  }

  return ContentService.createTextOutput('OK');
}

function verifyStripeSignature(payload, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET || !sigHeader) return false;
  try {
    // sigHeader 例: "t=1234567890,v1=abcdef..."
    var parts = {};
    sigHeader.split(',').forEach(function(p) {
      var kv = p.split('=');
      parts[kv[0]] = kv.slice(1).join('=');
    });
    var t  = parts['t']  || '';
    var v1 = parts['v1'] || '';
    if (!t || !v1) return false;

    var signedPayload = t + '.' + payload;
    var secret = STRIPE_WEBHOOK_SECRET.replace('whsec_', '');
    var keyBytes = Utilities.base64Decode(secret);
    var sigBytes = Utilities.computeHmacSha256Signature(
      Utilities.newBlob(signedPayload).getBytes(),
      keyBytes
    );
    var computed = sigBytes.map(function(b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    }).join('');

    return computed === v1;
  } catch (err) {
    Logger.log('Signature error: ' + err);
    return false;
  }
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
  headers.forEach(function(h, i) {
    var val = row[i];
    if (val == null) {
      obj[h] = '';
    } else if (val instanceof Date) {
      // 日付型は YYYY-MM-DD 形式に変換
      var y = val.getFullYear();
      var m = ('0' + (val.getMonth() + 1)).slice(-2);
      var d = ('0' + val.getDate()).slice(-2);
      obj[h] = y + '-' + m + '-' + d;
    } else {
      obj[h] = String(val);
    }
  });
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
  'submittedAt', 'payStatus', 'stripeSessionId'
];

function saveNaming(d) {
  var orderId = 'naming_' + Date.now();
  var desc    = '作品' + (d.workNo || d.workId || '') + '「' + (d.namingTitle || '') + '」';

  // 1. Stripe Checkout セッション作成
  var stripe = createStripeCheckout(orderId, desc);

  // 2. スプレッドシートに保存（支払い前は pending）
  var sheet = getSheet('namings', NAMING_HEADERS);
  sheet.appendRow([
    orderId,
    d.workId      || '',
    d.workNo      || '',
    d.genre       || '',
    d.namingTitle || '',
    d.person      || '',
    d.email       || '',
    d.comment     || '',
    new Date().toISOString(),
    'pending',
    stripe.sessionId || ''
  ]);

  if (!stripe.success) {
    return { success: false, error: 'stripe_error', detail: stripe.error };
  }

  // メール通知
  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail(NOTIFY_EMAIL,
        '【富士見文化室】名前申込が届きました（支払い待ち）',
        [
          '新しい名前申込が届きました。',
          '',
          '作品番号：' + (d.workNo || d.workId || '不明'),
          'ジャンル：' + (d.genre || ''),
          'つけた名前：' + (d.namingTitle || ''),
          '申込者：'   + (d.person || ''),
          'メール：'   + (d.email  || ''),
          'コメント：' + (d.comment || 'なし'),
          '',
          '※ Stripe での支払い完了後、payStatus が paid に更新されます。',
          '',
          '管理シート：https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID
        ].join('\n')
      );
    } catch(err) { Logger.log('Mail error: ' + err); }
  }

  // 申込者へサンクスメール
  if (d.email) {
    try {
      MailApp.sendEmail(d.email,
        '【富士見文化室】名前申込を受け付けました',
        [
          (d.person || 'お客様') + ' さん、ありがとうございます！',
          '',
          '以下の内容で名前申込を受け付けました。',
          'Stripeでのお支払いが完了すると、正式に申込完了となります。',
          '',
          '─────────────────',
          '作品番号：' + (d.workNo || d.workId || ''),
          'つけた名前：「' + (d.namingTitle || '') + '」',
          'コメント：' + (d.comment || 'なし'),
          '─────────────────',
          '',
          'アーティストが名前を選んだ結果は、会期中にご連絡いたします。',
          '選ばれた場合は作品をプレゼントします。お楽しみに！',
          '',
          '富士見文化室',
          LP_BASE_URL
        ].join('\n')
      );
    } catch(err) { Logger.log('Thanks mail error: ' + err); }
  }

  return {
    success:     true,
    orderId:     orderId,
    checkoutUrl: stripe.checkoutUrl
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

// ───────── CONTACTS ─────────

var CONTACT_HEADERS = [
  'id', 'name', 'email', 'type', 'message', 'submittedAt', 'status'
];

var CONTACT_TYPE_LABEL = {
  exhibit: '出展希望',
  press:   '取材・メディア',
  sponsor: '協賛・協力',
  other:   'その他'
};

function saveContact(d) {
  var id    = String(Date.now());
  var sheet = getSheet('contacts', CONTACT_HEADERS);
  // LP は inquiryType、管理画面は type でも送れるよう両対応
  var contactType = d.inquiryType || d.contactType || '';
  sheet.appendRow([
    id,
    d.name    || '',
    d.email   || '',
    contactType,
    d.message || '',
    new Date().toISOString(),
    'new'
  ]);

  // メール通知（NOTIFY_EMAIL が設定されている場合）
  if (NOTIFY_EMAIL) {
    var typeLabel = CONTACT_TYPE_LABEL[contactType] || contactType || 'その他';
    var subject   = '【富士見文化室】お問い合わせ：' + typeLabel + '（' + (d.name || '') + '）';
    var body      = [
      '新しいお問い合わせが届きました。',
      '',
      '種別：' + typeLabel,
      'お名前：' + (d.name || ''),
      'メール：' + (d.email || ''),
      '',
      '--- メッセージ ---',
      d.message || '',
      '-----------------',
      '',
      '管理シートで確認できます：',
      'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID
    ].join('\n');

    try {
      MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
    } catch (err) {
      Logger.log('Mail error: ' + err);
    }
  }

  // 申込者へサンクスメール
  if (d.email) {
    try {
      MailApp.sendEmail(d.email,
        '【富士見文化室】お問い合わせを受け付けました',
        [
          (d.name || 'お客様') + ' さん、ありがとうございます！',
          '',
          'お問い合わせを受け付けました。',
          '内容を確認の上、担当者よりご連絡いたします。',
          '',
          '─────────────────',
          '種別：' + (CONTACT_TYPE_LABEL[contactType] || contactType || 'その他'),
          'メッセージ：' + (d.message || ''),
          '─────────────────',
          '',
          '富士見文化室',
          LP_BASE_URL
        ].join('\n')
      );
    } catch(err) { Logger.log('Thanks mail error: ' + err); }
  }

  return { success: true, id: id };
}

function getContacts() {
  var sheet   = getSheet('contacts', CONTACT_HEADERS);
  var data    = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  return data.slice(1)
    .map(function(r) { return rowToObj(headers, r); })
    .sort(function(a, b) { return b.submittedAt > a.submittedAt ? 1 : -1; });
}
