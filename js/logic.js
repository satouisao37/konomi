'use strict';
// このみ — 純粋ロジック層。DOM・fetch・localStorage・Date.now() 直接参照は禁止(now は必ず引数で渡す)。
// plain script + グローバル名前空間(ES modules 不使用。strict eval でも漏れるよう globalThis 経由で公開)
var KONOMI = (typeof globalThis !== 'undefined' && globalThis.KONOMI) ? globalThis.KONOMI : {};
if (typeof globalThis !== 'undefined') globalThis.KONOMI = KONOMI;

KONOMI.logic = (function () {

  var CURRENT_VERSION = 1;
  var HISTORY_CAP = 20;
  var STORAGE_LIMIT_BYTES = 5 * 1024 * 1024; // iOS Safari のオリジン当たり目安

  // スコア定義(0なし4段階)
  var SCORES = [
    { score: -2, emoji: '🤢', label: '大嫌い' },
    { score: -1, emoji: '😕', label: '苦手' },
    { score: 1, emoji: '🙂', label: '好き' },
    { score: 2, emoji: '😍', label: '大好き' }
  ];

  var PRESET_CATEGORIES = [
    { id: 'c_preset_food', name: '食べ物', emoji: '🍜', sort: 10 },
    { id: 'c_preset_drink', name: '飲み物', emoji: '☕', sort: 20 },
    { id: 'c_preset_place', name: '場所', emoji: '🗺', sort: 30 },
    { id: 'c_preset_music', name: '音楽', emoji: '🎵', sort: 40 },
    { id: 'c_preset_word', name: 'ことば', emoji: '💬', sort: 50 },
    { id: 'c_preset_face', name: '表情', emoji: '🙂', sort: 60 }
  ];
  var MISC_CATEGORY = { id: 'c_preset_misc', name: '未分類', emoji: '📦', sort: 999 };

  function scoreDef(score) {
    for (var i = 0; i < SCORES.length; i++) if (SCORES[i].score === score) return SCORES[i];
    return null;
  }

  // ---- 正規化・ID ----

  // 検索・重複判定用の正規化: NFKC → trim → 小文字化 → カタカナ→ひらがな(ーは残す) → 連続空白圧縮
  function normalizeName(name) {
    var s = String(name == null ? '' : name);
    if (s.normalize) s = s.normalize('NFKC');
    s = s.trim().toLowerCase();
    s = s.replace(/[ァ-ヶ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0x60); });
    s = s.replace(/\s+/g, ' ');
    return s;
  }

  // id = 接頭辞 + '_' + 時刻base36 + '_' + ランダム4文字(rand4 は呼び出し側が生成して渡す)
  function genId(prefix, nowMs, rand4) {
    return prefix + '_' + nowMs.toString(36) + '_' + rand4;
  }

  // 端末オフセット付き ISO 文字列(例 2026-08-09T12:00:00+09:00)。tzOffsetMin は Date#getTimezoneOffset の値
  function toIso(nowMs, tzOffsetMin) {
    var shifted = new Date(nowMs - tzOffsetMin * 60000);
    var base = shifted.toISOString().slice(0, 19);
    var total = -tzOffsetMin;
    var sign = total >= 0 ? '+' : '-';
    var abs = Math.abs(total);
    var hh = String(Math.floor(abs / 60));
    var mm = String(abs % 60);
    if (hh.length < 2) hh = '0' + hh;
    if (mm.length < 2) mm = '0' + mm;
    return base + sign + hh + ':' + mm;
  }

  // ---- DB 生成・シード ----

  function makeEmptyDb(nowIso) {
    return {
      app: 'konomi',
      schema_version: CURRENT_VERSION,
      settings: {
        lastCategoryId: 'c_preset_food',
        lastBackupAt: null,
        dirtySinceBackup: 0,
        seenUnlockCount: 0,
        a2hsDismissed: false,
        firstRunNoticeDone: false
      },
      categories: PRESET_CATEGORIES.map(function (c) {
        return { id: c.id, name: c.name, emoji: c.emoji, preset: true, sort: c.sort, createdAt: nowIso };
      }),
      items: []
    };
  }

  // 未分類カテゴリを保証(無ければ追加した新 db を返す)
  function ensureMisc(db, nowIso) {
    for (var i = 0; i < db.categories.length; i++) {
      if (db.categories[i].id === MISC_CATEGORY.id) return db;
    }
    var cats = db.categories.concat([{
      id: MISC_CATEGORY.id, name: MISC_CATEGORY.name, emoji: MISC_CATEGORY.emoji,
      preset: true, sort: MISC_CATEGORY.sort, createdAt: nowIso
    }]);
    return assign(db, { categories: cats });
  }

  // ---- 汎用(浅い構造共有コピー) ----

  // ISO 文字列の時系列比較。オフセット混在(渡航等)でも実時刻で比較する。
  // どちらかが不正時刻なら文字列比較へフォールバック(NaN 比較でソートを壊さない)
  function cmpIso(a, b) {
    var ta = Date.parse(a);
    var tb = Date.parse(b);
    if (isNaN(ta) || isNaN(tb)) return a < b ? -1 : (a > b ? 1 : 0);
    return ta - tb;
  }

  function assign(base, patch) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    return out;
  }

  function itemScore(item) {
    return item.history[item.history.length - 1].score;
  }

  function categoryById(db, id) {
    for (var i = 0; i < db.categories.length; i++) if (db.categories[i].id === id) return db.categories[i];
    return null;
  }

  function itemById(db, id) {
    for (var i = 0; i < db.items.length; i++) if (db.items[i].id === id) return db.items[i];
    return null;
  }

  // history 上限適用: 超過時は「最初の1件+最新19件」(気変わり分析の始点を保全)
  function capHistory(history) {
    if (history.length <= HISTORY_CAP) return history;
    return [history[0]].concat(history.slice(history.length - (HISTORY_CAP - 1)));
  }

  // ---- 登録(スコアタップ=保存) ----

  // norm 完全一致の既存アイテムを全カテゴリ横断で探す
  function findByNorm(items, norm) {
    for (var i = 0; i < items.length; i++) if (items[i].norm === norm) return items[i];
    return null;
  }

  // 判定を適用した新 db を返す。既存 norm 一致なら再判定(history 追記)、無ければ新規作成。
  // 戻り値: { db, itemId, created, undo: {kind:'create'|'rejudge', itemId} }
  function applyJudgment(db, input) {
    var name = String(input.name == null ? '' : input.name).trim().replace(/\s+/g, ' ');
    var norm = normalizeName(name);
    if (!norm) return { db: db, error: 'empty' };
    if (!scoreDef(input.score)) return { db: db, error: 'badscore' };
    var existing = findByNorm(db.items, norm);
    var items;
    var itemId;
    var created;
    if (existing) {
      itemId = existing.id;
      created = false;
      items = db.items.map(function (it) {
        if (it.id !== existing.id) return it;
        return assign(it, {
          history: capHistory(it.history.concat([{ score: input.score, at: input.nowIso }])),
          updatedAt: input.nowIso
        });
      });
    } else {
      itemId = genId('i', input.nowMs, input.rand4);
      created = true;
      items = db.items.concat([{
        id: itemId,
        categoryId: input.categoryId,
        name: name,
        norm: norm,
        note: '',
        history: [{ score: input.score, at: input.nowIso }],
        createdAt: input.nowIso,
        updatedAt: input.nowIso
      }]);
    }
    var usedCategoryId = existing ? existing.categoryId : input.categoryId;
    var settings = assign(db.settings, { lastCategoryId: usedCategoryId });
    return {
      db: assign(db, { items: items, settings: settings }),
      itemId: itemId,
      created: created,
      undo: { kind: created ? 'create' : 'rejudge', itemId: itemId }
    };
  }

  // 判定の取り消し: 新規作成なら item ごと削除、再判定なら history 末尾を削除
  function undoJudgment(db, undo) {
    if (undo.kind === 'create') {
      return assign(db, { items: db.items.filter(function (it) { return it.id !== undo.itemId; }) });
    }
    var items = db.items.map(function (it) {
      if (it.id !== undo.itemId || it.history.length <= 1) return it;
      var h = it.history.slice(0, it.history.length - 1);
      return assign(it, { history: h, updatedAt: h[h.length - 1].at });
    });
    return assign(db, { items: items });
  }

  // ---- 候補サジェスト ----

  function grams2(s) {
    var out = {};
    for (var i = 0; i + 1 < s.length; i++) out[s.slice(i, i + 2)] = true;
    return out;
  }

  function gramOverlap(a, b) {
    var ga = grams2(a);
    var gb = grams2(b);
    var n = 0;
    for (var g in ga) if (Object.prototype.hasOwnProperty.call(gb, g)) n++;
    return n;
  }

  // スコア = 前方一致100 + 部分一致50 + 2-gram重複数。同点は updatedAt 降順。上位 limit 件。
  function suggest(query, items, limit) {
    var qn = normalizeName(query);
    if (!qn) return [];
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var s = 0;
      if (it.norm.indexOf(qn) === 0) s += 100;
      else if (it.norm.indexOf(qn) >= 0) s += 50;
      s += gramOverlap(qn, it.norm);
      if (s > 0) scored.push({ item: it, s: s });
    }
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return cmpIso(b.item.updatedAt, a.item.updatedAt);
    });
    return scored.slice(0, limit || 5).map(function (x) { return x.item; });
  }

  // 最近判定したアイテム(updatedAt 降順・重複なし)
  function recentItems(items, k) {
    return items.slice().sort(function (a, b) {
      return cmpIso(b.updatedAt, a.updatedAt);
    }).slice(0, k);
  }

  // ---- 編集(統合・カテゴリ操作) ----

  // 2アイテムの統合: history 結合(at 昇順・at+score 同値重複排除・上限適用)。
  // name/categoryId は primary 側、note は primary 優先(空なら other)。
  function mergeItems(primary, other) {
    var all = primary.history.concat(other.history).slice().sort(function (a, b) {
      return cmpIso(a.at, b.at);
    });
    var merged = [];
    for (var i = 0; i < all.length; i++) {
      var h = all[i];
      var last = merged[merged.length - 1];
      if (last && last.at === h.at && last.score === h.score) continue;
      merged.push({ score: h.score, at: h.at });
    }
    merged = capHistory(merged);
    return assign(primary, {
      note: primary.note ? primary.note : (other.note || ''),
      history: merged,
      createdAt: primary.createdAt < other.createdAt ? primary.createdAt : other.createdAt,
      updatedAt: merged[merged.length - 1].at
    });
  }

  // カテゴリ統合: from の所属 item を to へ付替えて from を削除
  function mergeCategory(db, fromId, toId) {
    var moved = 0;
    var items = db.items.map(function (it) {
      if (it.categoryId !== fromId) return it;
      moved++;
      return assign(it, { categoryId: toId });
    });
    var cats = db.categories.filter(function (c) { return c.id !== fromId; });
    var settings = db.settings.lastCategoryId === fromId
      ? assign(db.settings, { lastCategoryId: toId }) : db.settings;
    return { db: assign(db, { items: items, categories: cats, settings: settings }), moved: moved };
  }

  // カテゴリ削除: mode 'move'=所属アイテムを未分類へ / 'purge'=アイテムごと削除
  // 未分類自身を 'move' で消すと孤児が残るため拒否する(呼び出し側は purge のみ提示)
  function deleteCategory(db, id, mode, nowIso) {
    var affected = db.items.filter(function (it) { return it.categoryId === id; }).length;
    if (mode === 'move' && id === MISC_CATEGORY.id) {
      return { db: db, affected: affected, error: 'misc_move' };
    }
    var out;
    if (mode === 'move') {
      out = ensureMisc(db, nowIso);
      out = assign(out, {
        items: out.items.map(function (it) {
          return it.categoryId === id ? assign(it, { categoryId: MISC_CATEGORY.id }) : it;
        })
      });
    } else {
      out = assign(db, { items: db.items.filter(function (it) { return it.categoryId !== id; }) });
    }
    out = assign(out, { categories: out.categories.filter(function (c) { return c.id !== id; }) });
    if (out.settings.lastCategoryId === id) {
      var first = out.categories.slice().sort(function (a, b) { return a.sort - b.sort; })[0];
      out = assign(out, { settings: assign(out.settings, { lastCategoryId: first ? first.id : null }) });
    }
    return { db: out, affected: affected };
  }

  // ---- マイグレーション ----

  // 版番号 → 「1つ前の版の db を受け取り新しい版の db を返す」純関数。既知フィールドのみ触り未知は保持する。
  var MIGRATIONS = {};

  function migrate(db) {
    var from = db.schema_version;
    var cur = db;
    while (cur.schema_version < CURRENT_VERSION) {
      var next = cur.schema_version + 1;
      cur = MIGRATIONS[next](cur);
      cur = assign(cur, { schema_version: next });
    }
    return { db: cur, from: from, migrated: from < CURRENT_VERSION };
  }

  // ---- エクスポート / インポート ----

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  function checksumOf(data) {
    var hex = fnv1a(JSON.stringify(data));
    while (hex.length < 8) hex = '0' + hex;
    return hex;
  }

  function countJudgments(db) {
    var n = 0;
    for (var i = 0; i < db.items.length; i++) n += db.items[i].history.length;
    return n;
  }

  function buildExport(db, nowIso) {
    // ファイル自身が「この時点のバックアップ」なので、復元後に誤った督促が出ないよう
    // settings の督促カウンタはリセットした状態で書き出す
    var data = assign(db, {
      settings: assign(db.settings, { lastBackupAt: nowIso, dirtySinceBackup: 0 })
    });
    return {
      app: 'konomi',
      kind: 'backup',
      schema_version: db.schema_version,
      exported_at: nowIso,
      counts: { categories: db.categories.length, items: db.items.length, judgments: countJudgments(db) },
      checksum: checksumOf(data),
      data: data
    };
  }

  // 取り込みデータの検証と修復。戻り値:
  // { ok, fatal(文字列|null), warnings[], db(修復済み・ok時のみ), report{orphaned, dropped, sortedFix} }
  function validateImport(parsed, nowIso) {
    var warnings = [];
    if (!parsed || typeof parsed !== 'object') return { ok: false, fatal: 'JSON がオブジェクトではありません' };
    var envelope = !!(parsed.data && typeof parsed.data === 'object');
    var data = envelope ? parsed.data : parsed;
    if (parsed.app !== 'konomi' && data.app !== 'konomi') {
      return { ok: false, fatal: 'このみ のバックアップではありません(app 識別子が不一致)' };
    }
    if (envelope) {
      if (typeof parsed.checksum === 'string') {
        if (checksumOf(parsed.data) !== parsed.checksum) {
          return { ok: false, fatal: 'チェックサム不一致。ファイルが破損または切断されています' };
        }
      } else {
        warnings.push('チェックサムがありません(検証をスキップして続行できます)');
      }
    } else {
      warnings.push('エンベロープなしの生データです(konomi.db 形式として取り込みます)');
    }
    var version = typeof data.schema_version === 'number' ? data.schema_version : null;
    if (version === null) return { ok: false, fatal: 'schema_version がありません' };
    if (version > CURRENT_VERSION) {
      return { ok: false, fatal: 'アプリより新しいデータです。アプリを更新してから取り込んでください' };
    }
    if (version < 1 || version !== Math.floor(version)) {
      return { ok: false, fatal: '不明な schema_version です(' + version + ')' };
    }
    if (!Array.isArray(data.categories) || !Array.isArray(data.items)) {
      return { ok: false, fatal: 'categories / items がありません' };
    }
    var db = migrate(data).db;
    var repaired = repairDb(db, nowIso);
    return { ok: true, fatal: null, warnings: warnings, db: repaired.db, report: repaired.report };
  }

  // 参照整合の修復: 型不正の除去 / 孤児 item→未分類 / history を時系列昇順ソート /
  // 空 history item 除外 / norm 欠落の再導出 / settings.lastCategoryId の存在保証
  function repairDb(db, nowIso) {
    var report = { orphaned: 0, dropped: 0 };
    // カテゴリの型検証(不正要素は除去、欠落フィールドは補完)
    var categories = [];
    for (var c = 0; c < db.categories.length; c++) {
      var cat = db.categories[c];
      if (!cat || typeof cat !== 'object' || typeof cat.id !== 'string' || !cat.id) continue;
      categories.push(assign(cat, {
        name: typeof cat.name === 'string' && cat.name ? cat.name : '?',
        emoji: typeof cat.emoji === 'string' && cat.emoji ? cat.emoji : '🏷',
        sort: typeof cat.sort === 'number' ? cat.sort : 999
      }));
    }
    var catIds = {};
    for (var i = 0; i < categories.length; i++) catIds[categories[i].id] = true;
    var needMisc = false;
    var items = [];
    for (var j = 0; j < db.items.length; j++) {
      var it = db.items[j];
      if (!it || typeof it !== 'object' || typeof it.name !== 'string' || !Array.isArray(it.history)) {
        report.dropped++;
        continue;
      }
      // history エントリの型検証(score が4段階に無い・at が時刻でないものは捨てる)
      var h = it.history.filter(function (e) {
        return e && typeof e === 'object' && scoreDef(e.score) !== null
          && typeof e.at === 'string' && !isNaN(Date.parse(e.at));
      });
      if (h.length === 0) { report.dropped++; continue; }
      h = h.slice().sort(function (a, b) { return cmpIso(a.at, b.at); });
      var patch = { history: capHistory(h), updatedAt: h[h.length - 1].at };
      if (!catIds[it.categoryId]) { report.orphaned++; needMisc = true; patch.categoryId = MISC_CATEGORY.id; }
      if (typeof it.norm !== 'string' || !it.norm) patch.norm = normalizeName(it.name);
      if (typeof it.note !== 'string') patch.note = '';
      items.push(assign(it, patch));
    }
    var out = assign(db, { categories: categories, items: items });
    if (needMisc) out = ensureMisc(out, nowIso);
    var settings = out.settings && typeof out.settings === 'object' ? out.settings : makeEmptyDb(nowIso).settings;
    var lastOk = false;
    for (var k = 0; k < out.categories.length; k++) if (out.categories[k].id === settings.lastCategoryId) lastOk = true;
    if (!lastOk) {
      var sorted = out.categories.slice().sort(function (a, b) { return a.sort - b.sort; });
      settings = assign(settings, { lastCategoryId: sorted.length ? sorted[0].id : null });
    }
    out = assign(out, { settings: settings });
    return { db: out, report: report };
  }

  // ---- バックアップ督促・ストレージ ----

  // 「最終バックアップから14日超 かつ 変更10件以上」または「変更50件以上」
  function backupDue(settings, nowMs) {
    var dirty = settings.dirtySinceBackup || 0;
    if (dirty >= 50) return true;
    if (dirty < 10) return false;
    if (!settings.lastBackupAt) return true;
    var elapsed = nowMs - Date.parse(settings.lastBackupAt);
    return elapsed > 14 * 24 * 3600 * 1000;
  }

  function daysSince(iso, nowMs) {
    if (!iso) return null;
    return Math.floor((nowMs - Date.parse(iso)) / (24 * 3600 * 1000));
  }

  function storageInfo(rawLength) {
    var bytes = rawLength * 2; // JS 文字列は UTF-16 換算
    return { kb: Math.round(bytes / 1024), percent: Math.min(100, Math.round(bytes / STORAGE_LIMIT_BYTES * 100)) };
  }

  // ---- 表示補助 ----

  // 今日 / 昨日 / n日前(30日まで) / それ以前は YYYY/M/D
  function relativeDay(iso, nowMs, tzOffsetMin) {
    var dayMs = 24 * 3600 * 1000;
    var local = function (ms) { return Math.floor((ms - tzOffsetMin * 60000) / dayMs); };
    var diff = local(nowMs) - local(Date.parse(iso));
    if (diff <= 0) return '今日';
    if (diff === 1) return '昨日';
    if (diff <= 30) return diff + '日前';
    var d = new Date(Date.parse(iso) - tzOffsetMin * 60000);
    return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
  }

  // ---- 分析 ----

  // カード定義と解放判定。イベント解放(気変わり)は changes 件数で判定
  function computeUnlocks(db) {
    var n = db.items.length;
    var changes = computeChanges(db.items).length;
    var cards = [
      { key: 'gauge', name: 'このみ計', threshold: 1, current: n, unlocked: n >= 1 },
      { key: 'hall', name: '殿堂とブラックリスト', threshold: 5, current: n, unlocked: n >= 5 },
      { key: 'balance', name: 'カテゴリ別 好悪バランス', threshold: 10, current: n, unlocked: n >= 10 },
      { key: 'clarity', name: 'はっきり度', threshold: 15, current: n, unlocked: n >= 15 },
      { key: 'changes', name: '気変わりタイムライン', threshold: null, current: changes, unlocked: changes >= 1, eventHint: '同じものをもう一度判定すると解放' },
      { key: 'keywords', name: 'キーワード傾向', threshold: 30, current: n, unlocked: n >= 30 },
      { key: 'profile', name: 'このみプロファイル', threshold: 30, current: n, unlocked: n >= 30 }
    ];
    var unlockedCount = 0;
    for (var i = 0; i < cards.length; i++) if (cards[i].unlocked) unlockedCount++;
    return { cards: cards, unlockedCount: unlockedCount };
  }

  // 陽性度 = (現在スコア平均 + 2) / 4 → 0〜100%
  function computeGauge(items) {
    if (!items.length) return null;
    var sum = 0;
    for (var i = 0; i < items.length; i++) sum += itemScore(items[i]);
    var avg = sum / items.length;
    return { n: items.length, avg: avg, percent: Math.round((avg + 2) / 4 * 100) };
  }

  // 現在スコア +2(殿堂)と −2(ブラックリスト)。updatedAt 降順・各最大20件
  function computeHallOfFame(items) {
    var by = function (score) {
      return recentItems(items.filter(function (it) { return itemScore(it) === score; }), 20);
    };
    return { best: by(2), worst: by(-2) };
  }

  // カテゴリごとの現在スコア分布。平均スコア降順
  function computeCategoryBalance(db) {
    var rows = [];
    for (var i = 0; i < db.categories.length; i++) {
      var cat = db.categories[i];
      var counts = { m2: 0, m1: 0, p1: 0, p2: 0 };
      var sum = 0;
      var n = 0;
      for (var j = 0; j < db.items.length; j++) {
        var it = db.items[j];
        if (it.categoryId !== cat.id) continue;
        var s = itemScore(it);
        n++;
        sum += s;
        if (s === -2) counts.m2++;
        else if (s === -1) counts.m1++;
        else if (s === 1) counts.p1++;
        else counts.p2++;
      }
      if (n > 0) rows.push({ categoryId: cat.id, name: cat.name, emoji: cat.emoji, counts: counts, n: n, avg: sum / n });
    }
    rows.sort(function (a, b) { return b.avg - a.avg; });
    return rows;
  }

  // ±2率と好き側/嫌い側の非対称
  function computeClarity(items) {
    var n = items.length;
    if (!n) return null;
    var counts = { m2: 0, m1: 0, p1: 0, p2: 0 };
    for (var i = 0; i < items.length; i++) {
      var s = itemScore(items[i]);
      if (s === -2) counts.m2++;
      else if (s === -1) counts.m1++;
      else if (s === 1) counts.p1++;
      else counts.p2++;
    }
    var extreme = counts.m2 + counts.p2;
    var rate = Math.round(extreme / n * 100);
    var likeN = counts.p1 + counts.p2;
    var dislikeN = counts.m1 + counts.m2;
    var likeRate = likeN ? counts.p2 / likeN * 100 : null;
    var dislikeRate = dislikeN ? counts.m2 / dislikeN * 100 : null;
    var asym = null;
    if (likeN >= 4 && dislikeN >= 4 && likeRate !== null && dislikeRate !== null && Math.abs(likeRate - dislikeRate) > 25) {
      asym = likeRate > dislikeRate
        ? '「好き」は振り切りやすく、「嫌い」は控えめです'
        : '「嫌い」は振り切りやすく、「好き」は控えめです';
    }
    return {
      n: n, counts: counts, extremeRate: rate,
      label: rate > 50 ? '白黒ハッキリ型' : 'グラデーション型',
      likeExtremeRate: likeRate === null ? null : Math.round(likeRate),
      dislikeExtremeRate: dislikeRate === null ? null : Math.round(dislikeRate),
      asymmetry: asym
    };
  }

  // 気変わり: history 2件以上かつ |最新 − 初回| ≥ 2。updatedAt 降順・最大15件
  function computeChanges(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.history.length < 2) continue;
      var first = it.history[0].score;
      var last = itemScore(it);
      if (Math.abs(last - first) < 2) continue;
      out.push({ id: it.id, name: it.name, first: first, last: last, at: it.updatedAt, dir: last > first ? 'up' : 'down' });
    }
    out.sort(function (a, b) { return cmpIso(b.at, a.at); });
    return out.slice(0, 15);
  }

  var GRAM_REJECT = /[0-9!-\/:-@\[-`{-~ー\s。、・「」『』()【】〜~]/;
  var GRAM_REQUIRE = /[㐀-鿿豈-﫿a-z]/; // 漢字か英字を1文字以上

  // アイテム名 norm の文字2-gram傾向。3アイテム以上に出現する gram のみ。
  function computeKeywords(items) {
    var map = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var seen = {};
      for (var p = 0; p + 1 < it.norm.length; p++) {
        var g = it.norm.slice(p, p + 2);
        if (seen[g]) continue;
        if (GRAM_REJECT.test(g)) continue;
        if (!GRAM_REQUIRE.test(g)) continue; // ひらがなのみ(助詞断片)除外
        seen[g] = true;
        if (!map[g]) map[g] = { gram: g, n: 0, sum: 0 };
        map[g].n++;
        map[g].sum += itemScore(it);
      }
    }
    var all = [];
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var e = map[key];
      if (e.n >= 3) all.push({ gram: e.gram, n: e.n, avg: e.sum / e.n });
    }
    var top = all.filter(function (e) { return e.avg > 0; }).sort(function (a, b) { return b.avg - a.avg || b.n - a.n; }).slice(0, 5);
    var bottom = all.filter(function (e) { return e.avg < 0; }).sort(function (a, b) { return a.avg - b.avg || b.n - a.n; }).slice(0, 5);
    return { top: top, bottom: bottom };
  }

  // ルールベースのプロファイル文とスタットタイル
  function computeProfile(db, nowMs) {
    var items = db.items;
    var n = items.length;
    if (!n) return null;
    var gauge = computeGauge(items);
    var clarity = computeClarity(items);
    var balance = computeCategoryBalance(db);
    var most = null;
    for (var i = 0; i < balance.length; i++) if (!most || balance[i].n > most.n) most = balance[i];
    var eligible = balance.filter(function (r) { return r.n >= 5; });
    var kind = null;
    var harsh = null;
    if (eligible.length >= 2) {
      kind = eligible[0];
      harsh = eligible[eligible.length - 1];
      if (kind.categoryId === harsh.categoryId) { kind = null; harsh = null; }
    }
    var stance = gauge.percent >= 60 ? '「好きから入る」' : (gauge.percent <= 40 ? '「慎重に選ぶ」' : 'バランス派の');
    var text = 'あなたは「' + most.name + '」をよく記録する' + stance + 'タイプ。'
      + 'はっきり度は' + clarity.extremeRate + '%(' + clarity.label + ')。';
    if (kind && harsh) text += '「' + kind.name + '」にはやさしく、「' + harsh.name + '」には辛口です。';
    var recent = 0;
    var changes = computeChanges(items);
    for (var j = 0; j < changes.length; j++) {
      if (nowMs - Date.parse(changes[j].at) <= 30 * 24 * 3600 * 1000) recent++;
    }
    if (recent > 0) text += 'この1か月で' + recent + '件の気変わりがありました。';
    var likeCount = 0;
    for (var k = 0; k < items.length; k++) if (itemScore(items[k]) > 0) likeCount++;
    return {
      text: text,
      tiles: [
        { label: '記録', value: String(n), unit: '件' },
        { label: '好き率', value: String(Math.round(likeCount / n * 100)), unit: '%' },
        { label: '±2率', value: String(clarity.extremeRate), unit: '%' }
      ]
    };
  }

  return {
    CURRENT_VERSION: CURRENT_VERSION,
    HISTORY_CAP: HISTORY_CAP,
    SCORES: SCORES,
    PRESET_CATEGORIES: PRESET_CATEGORIES,
    MISC_CATEGORY: MISC_CATEGORY,
    MIGRATIONS: MIGRATIONS,
    scoreDef: scoreDef,
    normalizeName: normalizeName,
    genId: genId,
    toIso: toIso,
    cmpIso: cmpIso,
    makeEmptyDb: makeEmptyDb,
    ensureMisc: ensureMisc,
    assign: assign,
    itemScore: itemScore,
    categoryById: categoryById,
    itemById: itemById,
    capHistory: capHistory,
    findByNorm: findByNorm,
    applyJudgment: applyJudgment,
    undoJudgment: undoJudgment,
    suggest: suggest,
    recentItems: recentItems,
    mergeItems: mergeItems,
    mergeCategory: mergeCategory,
    deleteCategory: deleteCategory,
    migrate: migrate,
    fnv1a: fnv1a,
    checksumOf: checksumOf,
    countJudgments: countJudgments,
    buildExport: buildExport,
    validateImport: validateImport,
    repairDb: repairDb,
    backupDue: backupDue,
    daysSince: daysSince,
    storageInfo: storageInfo,
    relativeDay: relativeDay,
    computeUnlocks: computeUnlocks,
    computeGauge: computeGauge,
    computeHallOfFame: computeHallOfFame,
    computeCategoryBalance: computeCategoryBalance,
    computeClarity: computeClarity,
    computeChanges: computeChanges,
    computeKeywords: computeKeywords,
    computeProfile: computeProfile
  };
})();
