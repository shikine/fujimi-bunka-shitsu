// ============================================================
//  富士見文化室 — Google Apps Script バックエンド
//
//  【セットアップ手順】
//  1. Google スプレッドシートを新規作成する
//  2. スプレッドシートのURL内の ID をコピー
//     例) https://docs.google.com/spreadsheets/d/【ここ】/edit
//  3. 下の SPREADSHEET_ID を書き換える
//  4. ADMIN_KEY を好きなパスワードに変更する
//  5. Apps Script エディタで「デプロイ」→「新しいデプロイ」
//     種類: ウェブアプリ / 実行: 自分 / アクセス: 全員
//  6. 発行された URL を LP と admin.html の APPS_SCRIPT_URL に貼る
// ============================================================

var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID'; // ← 変更必須
var ADMIN_KEY      = 'fujimi-admin-2025';    // ← 好きなパスワードに変更

// ───────── エントリポイント ─────────

function doGet(e) {
  var type = e.parameter.type || '';
  var key  = e.parameter.key  || '';

  if (type === 'news')    return jsonRes(getNews());
  if (type === 'auth')    return jsonRes({ ok: key === ADMIN_KEY });
  if (type === 'namings' && key === ADMIN_KEY) return jsonRes(getNamings());

  return jsonRes({ error: 'not_found' });
}

function doPost(e) {
  var payload;
  try {
    var raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    payload = JSON.parse(raw);
  } catch (_) {
    return jsonRes({ error: 'bad_request' });
  }

  var type = payload.type      || '';
  var key  = payload.adminKey  || '';

  if (type === 'naming')     return jsonRes(saveNaming(payload));

  if (key !== ADMIN_KEY)     return jsonRes({ error: 'unauthorized' });
  if (type === 'addNews')    return jsonRes(addNews(payload));
  if (type === 'updateNews') return jsonRes(updateNews(payload));
  if (type === 'deleteNews') return jsonRes(deleteNews(payload));

  return jsonRes({ error: 'not_found' });
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

function saveNaming(d) {
  var sheet = getSheet('namings', ['workId', 'artist', 'genre', 'namingTitle', 'person', 'email', 'comment', 'submittedAt', 'status']);
  sheet.appendRow([
    d.workId||'', d.artist||'', d.genre||'',
    d.namingTitle||'', d.person||'', d.email||'',
    d.comment||'', new Date().toISOString(), 'pending'
  ]);
  return { success: true };
}

function getNamings() {
  var sheet   = getSheet('namings', ['workId', 'artist', 'genre', 'namingTitle', 'person', 'email', 'comment', 'submittedAt', 'status']);
  var data    = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  return data.slice(1).map(function(r) { return rowToObj(headers, r); });
}
