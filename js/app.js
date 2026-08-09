'use strict';
// このみ — 副作用層。localStorage・DOM・Service Worker・イベントはすべてここに閉じ込める。
var KONOMI = (typeof globalThis !== 'undefined' && globalThis.KONOMI) ? globalThis.KONOMI : {};
if (typeof globalThis !== 'undefined') globalThis.KONOMI = KONOMI;

KONOMI.app = (function () {

  var L = KONOMI.logic;
  var C = KONOMI.charts;
  var esc = C.esc;

  var VERSION = 'v1.0.0';
  var KEY_DB = 'konomi.db';
  var KEY_PREV = 'konomi.db.prev';
  var KEY_PREIMPORT = 'konomi.db.preimport';

  var state = {
    db: null,
    readOnly: false,
    route: { screen: 'record', itemId: null },
    selCategoryId: null,
    composing: false,
    zukan: { search: '', sort: 'updated', filter: 'all', cat: 'all', limit: 100 },
    undoSlot: null,          // { label, snapshot } 単発undo(メモリのみ)
    session: { nagDismissed: false, reloading: false, updateRequested: false },
    userCategoryId: null,    // ユーザーが自分で選んだカテゴリ(重複ガードの自動スイッチから戻す用)
    pendingNoteFocus: false,
    listObserver: null
  };

  // ---- 時刻・乱数 ----

  function nowMs() { return Date.now(); }
  function tzMin() { return new Date().getTimezoneOffset(); }
  function nowIso() { return L.toIso(nowMs(), tzMin()); }

  var B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  function rand4() {
    var out = '';
    if (window.crypto && crypto.getRandomValues) {
      var buf = new Uint8Array(4);
      crypto.getRandomValues(buf);
      for (var i = 0; i < 4; i++) out += B36[buf[i] % 36];
    } else {
      for (var j = 0; j < 4; j++) out += B36[Math.floor(Math.random() * 36)];
    }
    return out;
  }

  // ---- 保存・読込・破損復旧 ----

  function persist() {
    if (state.readOnly) { toast('閲覧専用モードのため保存できません'); return false; }
    var str;
    try {
      str = JSON.stringify(state.db);
    } catch (e) {
      toast('保存に失敗しました: ' + e.message);
      return false;
    }
    try {
      var cur = localStorage.getItem(KEY_DB);
      if (cur !== null) localStorage.setItem(KEY_PREV, cur);
      localStorage.setItem(KEY_DB, str);
      return true;
    } catch (e2) {
      dialog({
        title: '保存できません',
        body: '<p>ストレージ容量が不足しています。バックアップを書き出してから、不要なアイテムを削除してください。</p>',
        buttons: [
          { label: '書き出す', cls: 'btn-primary', cb: doExport },
          { label: '閉じる', cls: 'btn-secondary' }
        ]
      });
      return false;
    }
  }

  // 変更を確定して保存・再描画する共通経路
  function commit(newDb, opts) {
    opts = opts || {};
    if (state.readOnly) { toast('閲覧専用モードです'); return false; }
    if (!opts.noDirty) {
      newDb = L.assign(newDb, {
        settings: L.assign(newDb.settings, { dirtySinceBackup: (newDb.settings.dirtySinceBackup || 0) + 1 })
      });
    }
    state.db = newDb;
    if (!opts.keepUndo) state.undoSlot = null;
    persist();
    if (!opts.noRender) render();
    return true;
  }

  // JSON.parse が通っても骨格が壊れていれば「破損」として扱う(起動時 TypeError で操作不能になるのを防ぐ)
  function structurallySound(parsed) {
    return !!(parsed && typeof parsed === 'object'
      && typeof parsed.schema_version === 'number'
      && Array.isArray(parsed.categories) && Array.isArray(parsed.items)
      && parsed.settings && typeof parsed.settings === 'object');
  }

  function parseSound(str) {
    var p = JSON.parse(str);
    if (!structurallySound(p)) throw new Error('構造不正');
    return p;
  }

  function loadDb() {
    var raw = null;
    try { raw = localStorage.getItem(KEY_DB); } catch (e) { raw = null; }
    if (raw === null) {
      state.db = L.makeEmptyDb(nowIso());
      persist();
      return;
    }
    var parsed = null;
    try {
      parsed = parseSound(raw);
    } catch (e2) {
      var prev = null;
      try { prev = localStorage.getItem(KEY_PREV); } catch (e3) { prev = null; }
      if (prev !== null) {
        try {
          parsed = parseSound(prev);
          // 先に正常文字列を本体キーへ書き戻す。こうすると直後の persist が
          // 破損文字列を prev へ退避してしまう(唯一の正常コピーを潰す)事故が起きない
          try { localStorage.setItem(KEY_DB, prev); } catch (e5) { /* 続行 */ }
          state.db = finishLoad(parsed);
          persist();
          toast('データ破損を検知し、直前の状態に復元しました');
          return;
        } catch (e4) { parsed = null; }
      }
      rescueScreen(raw);
      state.db = L.makeEmptyDb(nowIso()); // 画面骨格用(保存はしない。復旧確定までユーザーデータに触れない)
      state.readOnly = true;
      return;
    }
    state.db = finishLoad(parsed);
  }

  // マイグレーション・将来バージョンガードを通して db を確定する
  function finishLoad(parsed) {
    if (typeof parsed.schema_version === 'number' && parsed.schema_version > L.CURRENT_VERSION) {
      state.readOnly = true;
      return parsed; // 触らない(エクスポートのみ許可)
    }
    if (typeof parsed.schema_version === 'number' && parsed.schema_version < L.CURRENT_VERSION) {
      try {
        // 適用前スナップショットを1世代だけ残す
        var toRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf('konomi.premigrate.') === 0) toRemove.push(k);
        }
        for (var j = 0; j < toRemove.length; j++) localStorage.removeItem(toRemove[j]);
        localStorage.setItem('konomi.premigrate.v' + parsed.schema_version, JSON.stringify(parsed));
      } catch (e) { /* 退避失敗は続行(本体マイグレーションを妨げない) */ }
      var migrated = L.migrate(parsed).db;
      state.db = migrated;
      persist();
      return migrated;
    }
    return parsed;
  }

  function rescueScreen(raw) {
    var overlay = document.getElementById('overlay');
    overlay.className = 'overlay show';
    overlay.innerHTML =
      '<div class="dialog rescue">' +
      '<h2>データを読み込めません</h2>' +
      '<p>保存データが破損しています。下の内容をコピーして保管すれば、手動で復旧できる可能性があります。</p>' +
      '<textarea readonly id="rescueText"></textarea>' +
      '<div class="dialog-btns">' +
      '<button class="btn btn-secondary" id="rescueCopy">全文コピー</button>' +
      '<button class="btn btn-danger" id="rescueReset">初期化する</button>' +
      '</div></div>';
    document.getElementById('rescueText').value = raw;
    document.getElementById('rescueCopy').addEventListener('click', function () {
      copyText(raw);
    });
    document.getElementById('rescueReset').addEventListener('click', function () {
      dialog({
        title: '本当に初期化しますか?',
        body: '<p>破損データを破棄して、空の状態から始めます。</p>',
        buttons: [
          { label: '初期化する', cls: 'btn-danger', cb: function () {
            state.readOnly = false;
            state.db = L.makeEmptyDb(nowIso());
            persist();
            overlay.className = 'overlay';
            overlay.innerHTML = '';
            render();
          } },
          { label: 'キャンセル', cls: 'btn-secondary' }
        ]
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('コピーしました'); },
        function () { toast('コピーできませんでした'); });
    } else {
      toast('コピーできませんでした');
    }
  }

  // ---- トースト・ダイアログ ----

  var toastTimer = null;
  function toast(html, actions, ms) {
    var box = document.getElementById('toast');
    var inner = '<span class="toast-msg">' + html + '</span>';
    if (actions && actions.length) {
      inner += '<span class="toast-actions">';
      for (var i = 0; i < actions.length; i++) {
        inner += '<button class="toast-btn" data-i="' + i + '">' + esc(actions[i].label) + '</button>';
      }
      inner += '</span>';
    }
    box.innerHTML = inner;
    box.className = 'toast show';
    var btns = box.querySelectorAll('.toast-btn');
    for (var j = 0; j < btns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var act = actions[parseInt(btn.getAttribute('data-i'), 10)];
          hideToast();
          if (act.cb) act.cb();
        });
      })(btns[j]);
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms || 6000);
  }

  function hideToast() {
    document.getElementById('toast').className = 'toast';
  }

  // 汎用ダイアログ。buttons: [{label, cls, cb, keep}]
  function dialog(opts) {
    var overlay = document.getElementById('overlay');
    overlay.className = 'overlay show';
    var html = '<div class="dialog">';
    if (opts.title) html += '<h2>' + esc(opts.title) + '</h2>';
    html += '<div class="dialog-body">' + (opts.body || '') + '</div><div class="dialog-btns">';
    for (var i = 0; i < opts.buttons.length; i++) {
      html += '<button class="btn ' + (opts.buttons[i].cls || 'btn-secondary') + '" data-i="' + i + '">'
        + esc(opts.buttons[i].label) + '</button>';
    }
    html += '</div></div>';
    overlay.innerHTML = html;
    var btns = overlay.querySelectorAll('.dialog-btns .btn');
    for (var j = 0; j < btns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var act = opts.buttons[parseInt(btn.getAttribute('data-i'), 10)];
          if (!act.keep) closeDialog();
          if (act.cb) act.cb();
        });
      })(btns[j]);
    }
    if (opts.onOpen) opts.onOpen(overlay);
  }

  function closeDialog() {
    var overlay = document.getElementById('overlay');
    overlay.className = 'overlay';
    overlay.innerHTML = '';
  }

  // 破壊的操作の直前スナップショットを取り、undo トーストを出す
  function destructive(label, mutate) {
    var snapshot = JSON.parse(JSON.stringify(state.db));
    if (!mutate()) return;
    state.undoSlot = { snapshot: snapshot };
    toast(esc(label), [{ label: '取り消す', cb: function () {
      if (!state.undoSlot) return;
      var snap = state.undoSlot.snapshot;
      state.undoSlot = null;
      commit(snap, { noDirty: true });
    } }]);
  }

  // ---- ルーティング ----

  function parseHash() {
    var h = location.hash || '#/record';
    var m = h.match(/^#\/(record|zukan|stats|settings)(?:\/([^/]+))?$/);
    if (!m) return { screen: 'record', itemId: null };
    return { screen: m[1], itemId: m[2] || null };
  }

  function nav(hash) { location.hash = hash; }

  function onHashChange() {
    state.route = parseHash();
    // シートはハッシュで開閉(戻るスワイプで閉じる)。itemId の無いルートでは
    // 遷移元の画面種別に関わらずシートを必ず掃除する(記録・分析経由の残留防止)
    if (!state.route.itemId) {
      var overlay = document.getElementById('overlay');
      if (overlay.className.indexOf('sheet-mode') >= 0) {
        overlay.className = 'overlay';
        overlay.innerHTML = '';
      }
    }
    render();
  }

  // ---- 共通描画 ----

  function render() {
    renderTabbar();
    var main = document.getElementById('main');
    var dock = document.getElementById('scoreDock');
    if (state.route.screen === 'record') {
      renderRecord(main);
      dock.className = 'score-dock show';
      renderDock();
    } else {
      dock.className = 'score-dock';
      if (state.route.screen === 'zukan') renderZukan(main);
      else if (state.route.screen === 'stats') renderStats(main);
      else renderSettings(main);
    }
    if (state.route.screen === 'zukan' && state.route.itemId) openSheet(state.route.itemId);
  }

  function renderTabbar() {
    var unlocks = L.computeUnlocks(state.db);
    var badge = unlocks.unlockedCount > (state.db.settings.seenUnlockCount || 0);
    var backupBadge = !state.readOnly && L.backupDue(state.db.settings, nowMs());
    var tabs = [
      { key: 'record', emoji: '❤️', label: '記録' },
      { key: 'zukan', emoji: '📖', label: '図鑑' },
      { key: 'stats', emoji: '📊', label: '分析' },
      { key: 'settings', emoji: '⚙️', label: '設定' }
    ];
    var html = '';
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var active = state.route.screen === t.key;
      var dot = (t.key === 'stats' && badge) || (t.key === 'settings' && backupBadge);
      html += '<button class="tab' + (active ? ' active' : '') + '" data-nav="#/' + t.key + '">'
        + '<span class="tab-emoji">' + t.emoji + (dot ? '<span class="dot"></span>' : '') + '</span>'
        + '<span class="tab-label">' + t.label + '</span></button>';
    }
    var bar = document.getElementById('tabbar');
    bar.innerHTML = html;
    var btns = bar.querySelectorAll('.tab');
    for (var j = 0; j < btns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () { nav(btn.getAttribute('data-nav')); });
      })(btns[j]);
    }
  }

  function banners() {
    var html = '';
    if (state.readOnly) {
      html += '<div class="banner banner-warn">アプリが古い可能性があります。再読み込みしてください '
        + '<button class="btn-mini" data-act="reload">再読み込み</button></div>';
    }
    var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    if (!standalone && !state.db.settings.a2hsDismissed) {
      html += '<div class="banner">共有ボタン →「ホーム画面に追加」でアプリとして使えます(Safari タブのままだと、7日間開かないとデータが消えることがあります)'
        + '<button class="btn-mini" data-act="a2hs-close">閉じる</button></div>';
    }
    if (!state.readOnly && L.backupDue(state.db.settings, nowMs()) && !state.session.nagDismissed) {
      var days = L.daysSince(state.db.settings.lastBackupAt, nowMs());
      html += '<div class="banner">' + (days === null ? 'まだバックアップがありません' : '最終バックアップから' + days + '日')
        + '・変更' + (state.db.settings.dirtySinceBackup || 0) + '件。書き出しませんか? '
        + '<button class="btn-mini" data-act="nag-export">書き出す</button>'
        + '<button class="btn-mini" data-act="nag-later">あとで</button></div>';
    }
    if (!state.readOnly && !state.db.settings.firstRunNoticeDone) {
      html += '<div class="card notice-card"><h2>はじめに</h2>'
        + '<p>データはこの端末の Safari 領域だけに保存されます。Safari の「履歴と Web サイトデータを消去」で消えるため、設定タブから定期的にエクスポートしてください。</p>'
        + '<button class="btn btn-primary" data-act="notice-ok">わかった</button></div>';
    }
    return html;
  }

  function bindBanners(root) {
    var els = root.querySelectorAll('[data-act]');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var act = el.getAttribute('data-act');
        el.addEventListener('click', function () {
          if (act === 'reload') location.reload();
          else if (act === 'a2hs-close') {
            commit(L.assign(state.db, { settings: L.assign(state.db.settings, { a2hsDismissed: true }) }), { noDirty: true });
          } else if (act === 'nag-export') doExport();
          else if (act === 'nag-later') { state.session.nagDismissed = true; render(); }
          else if (act === 'notice-ok') {
            commit(L.assign(state.db, { settings: L.assign(state.db.settings, { firstRunNoticeDone: true }) }), { noDirty: true });
          }
        });
      })(els[i]);
    }
  }

  function scoreEmoji(score) {
    var d = L.scoreDef(score);
    return d ? d.emoji : '❓';
  }

  // ---- 記録画面 ----

  function renderRecord(main) {
    if (!state.selCategoryId || !L.categoryById(state.db, state.selCategoryId)) {
      state.selCategoryId = state.db.settings.lastCategoryId;
      if (!L.categoryById(state.db, state.selCategoryId)) {
        var sorted = state.db.categories.slice().sort(function (a, b) { return a.sort - b.sort; });
        state.selCategoryId = sorted.length ? sorted[0].id : null;
      }
    }
    if (!state.userCategoryId || !L.categoryById(state.db, state.userCategoryId)) {
      state.userCategoryId = state.selCategoryId;
    }
    var recent3 = L.recentItems(state.db.items, 3);
    var chips = L.recentItems(state.db.items, 8);
    var cats = state.db.categories.slice().sort(function (a, b) { return a.sort - b.sort; });

    var html = banners();
    html += '<div class="record-top">';
    if (recent3.length) {
      html += '<div class="recent-log card-flat"><div class="label">直近の記録</div>';
      for (var i = 0; i < recent3.length; i++) {
        var it = recent3[i];
        html += '<button class="recent-row" data-item="' + esc(it.id) + '">'
          + '<span class="recent-emoji">' + scoreEmoji(L.itemScore(it)) + '</span>'
          + '<span class="recent-name">' + esc(it.name) + '</span>'
          + '<span class="recent-time">' + esc(L.relativeDay(it.updatedAt, nowMs(), tzMin())) + '</span></button>';
      }
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="record-bottom">';
    if (chips.length) {
      html += '<div class="label">もう一度判定</div><div class="chip-grid">';
      for (var j = 0; j < chips.length; j++) {
        html += '<button class="chip chip-item" data-name="' + esc(chips[j].name) + '">' + esc(C.truncate(chips[j].name, 8)) + '</button>';
      }
      html += '</div>';
    }
    html += '<div class="label">カテゴリ</div><div class="cat-scroll" id="catScroll">';
    for (var k = 0; k < cats.length; k++) {
      var c = cats[k];
      html += '<button class="chip chip-cat' + (c.id === state.selCategoryId ? ' active' : '') + '" data-cat="' + esc(c.id) + '">'
        + esc(c.emoji) + ' ' + esc(c.name) + '</button>';
    }
    html += '</div>';
    html += '<div class="input-wrap">'
      + '<input id="nameInput" type="text" placeholder="なにを判定する?" enterkeyhint="done" '
      + 'autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">'
      + '<button id="clearInput" class="input-clear" aria-label="クリア">×</button></div>'
      + '<div id="dupStatus" class="dup-status"></div>'
      + '<div id="suggestList" class="suggest-list"></div>';
    html += '</div>';

    main.innerHTML = '<section class="screen screen-record">' + html + '</section>';
    bindBanners(main);

    var input = document.getElementById('nameInput');
    input.addEventListener('input', function () { if (!state.composing) updateSuggest(); });
    input.addEventListener('compositionstart', function () { state.composing = true; });
    input.addEventListener('compositionend', function () { state.composing = false; updateSuggest(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') e.preventDefault(); // 空保存・IME 誤爆防止
    });
    document.getElementById('clearInput').addEventListener('click', function () {
      input.value = '';
      updateSuggest();
      input.focus();
    });

    var itemBtns = main.querySelectorAll('[data-item]');
    for (var m = 0; m < itemBtns.length; m++) {
      (function (btn) {
        btn.addEventListener('click', function () { nav('#/zukan/' + btn.getAttribute('data-item')); });
      })(itemBtns[m]);
    }
    var nameBtns = main.querySelectorAll('[data-name]');
    for (var n = 0; n < nameBtns.length; n++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          input.value = btn.getAttribute('data-name');
          updateSuggest();
        });
      })(nameBtns[n]);
    }
    var catBtns = main.querySelectorAll('[data-cat]');
    for (var p = 0; p < catBtns.length; p++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          state.selCategoryId = btn.getAttribute('data-cat');
          state.userCategoryId = state.selCategoryId;
          syncCatChips();
          updateSuggest();
        });
      })(catBtns[p]);
    }
    updateSuggest();
  }

  // 記録画面のカテゴリチップの active 表示を state.selCategoryId に同期する
  function syncCatChips() {
    var chips = document.querySelectorAll('#catScroll .chip-cat');
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = chips[i].getAttribute('data-cat') === state.selCategoryId
        ? 'chip chip-cat active' : 'chip chip-cat';
    }
  }

  // 入力に応じて候補と重複ガードを更新
  function updateSuggest() {
    var input = document.getElementById('nameInput');
    var dupBox = document.getElementById('dupStatus');
    var listBox = document.getElementById('suggestList');
    if (!input || !dupBox || !listBox) return;
    var q = input.value;
    var norm = L.normalizeName(q);
    var match = norm ? L.findByNorm(state.db.items, norm) : null;
    if (match) {
      var cat = L.categoryById(state.db, match.categoryId);
      dupBox.innerHTML = '登録済み: ' + esc(match.name) + '(' + (cat ? esc(cat.name) : '?') + '・現在 '
        + scoreEmoji(L.itemScore(match)) + ')→ タップで再判定になります';
      dupBox.className = 'dup-status show';
      // 仕様 §3.3: 既存アイテムのカテゴリへ自動スイッチ(保存先と表示の食い違いを防ぐ)
      state.selCategoryId = match.categoryId;
      syncCatChips();
    } else {
      dupBox.className = 'dup-status';
      dupBox.innerHTML = '';
      if (state.selCategoryId !== state.userCategoryId && L.categoryById(state.db, state.userCategoryId)) {
        state.selCategoryId = state.userCategoryId;
        syncCatChips();
      }
    }
    var sugs = norm && !match ? L.suggest(q, state.db.items, 5) : [];
    var html = '';
    for (var i = 0; i < sugs.length; i++) {
      var it = sugs[i];
      var c = L.categoryById(state.db, it.categoryId);
      html += '<button class="suggest-row" data-sname="' + esc(it.name) + '">'
        + '<span>' + (c ? esc(c.emoji) : '📦') + '</span>'
        + '<span class="suggest-name">' + esc(it.name) + '</span>'
        + '<span class="suggest-score">' + scoreEmoji(L.itemScore(it)) + '</span></button>';
    }
    listBox.innerHTML = html;
    var btns = listBox.querySelectorAll('[data-sname]');
    for (var j = 0; j < btns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          input.value = btn.getAttribute('data-sname');
          updateSuggest();
          input.focus();
        });
      })(btns[j]);
    }
  }

  function renderDock() {
    var dock = document.getElementById('scoreDock');
    var html = '';
    for (var i = 0; i < L.SCORES.length; i++) {
      var s = L.SCORES[i];
      html += '<button class="score-btn ' + C.scoreClass(s.score) + '-btn" data-score="' + s.score + '">'
        + '<span class="score-emoji">' + s.emoji + '</span><span class="score-label">' + s.label + '</span></button>';
    }
    dock.innerHTML = html;
    var btns = dock.querySelectorAll('.score-btn');
    for (var j = 0; j < btns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          saveJudgment(parseInt(btn.getAttribute('data-score'), 10), btn);
        });
      })(btns[j]);
    }
  }

  // スコアタップ=保存(確定ボタンは存在しない)
  function saveJudgment(score, btn) {
    if (state.readOnly) { toast('閲覧専用モードです'); return; }
    var input = document.getElementById('nameInput');
    if (!input) return;
    var name = input.value;
    if (!L.normalizeName(name)) {
      toast('名前を入力してください');
      input.focus();
      return;
    }
    var res = L.applyJudgment(state.db, {
      name: name, categoryId: state.selCategoryId, score: score,
      nowIso: nowIso(), nowMs: nowMs(), rand4: rand4()
    });
    if (res.error) { toast('保存できませんでした'); return; }
    var undo = res.undo;
    var itemId = res.itemId;
    var def = L.scoreDef(score);
    commit(res.db, { keepUndo: true, noRender: false });
    if (btn) {
      btn.classList.add('flash');
      setTimeout(function () { btn.classList.remove('flash'); }, 400);
    }
    // 連続登録: フォームをクリアしてフォーカスを戻す(保存タップと同一ジェスチャ内)
    var input2 = document.getElementById('nameInput');
    if (input2) { input2.value = ''; updateSuggest(); input2.focus(); }
    toast(esc(L.itemById(state.db, itemId).name) + ' を「' + def.emoji + ' ' + def.label + '」に記録しました', [
      { label: '取り消す', cb: function () {
        commit(L.undoJudgment(state.db, undo), { noDirty: true });
      } },
      { label: 'メモ', cb: function () {
        state.pendingNoteFocus = true;
        nav('#/zukan/' + itemId);
      } }
    ]);
  }

  // ---- 図鑑 ----

  function zukanItems() {
    var z = state.zukan;
    var items = state.db.items.slice();
    if (z.cat !== 'all') items = items.filter(function (it) { return it.categoryId === z.cat; });
    if (z.filter === 'like') items = items.filter(function (it) { return L.itemScore(it) > 0; });
    else if (z.filter === 'dislike') items = items.filter(function (it) { return L.itemScore(it) < 0; });
    var qn = L.normalizeName(z.search);
    if (qn) items = items.filter(function (it) { return it.norm.indexOf(qn) >= 0; });
    if (z.sort === 'name') items.sort(function (a, b) { return a.norm < b.norm ? -1 : (a.norm > b.norm ? 1 : 0); });
    else if (z.sort === 'score') items.sort(function (a, b) { return L.itemScore(b) - L.itemScore(a); });
    else items.sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : (a.updatedAt > b.updatedAt ? -1 : 0); });
    return items;
  }

  function renderZukan(main) {
    var z = state.zukan;
    var cats = state.db.categories.slice().sort(function (a, b) { return a.sort - b.sort; });
    var html = banners();
    html += '<div class="zukan-head">'
      + '<input id="zSearch" type="search" placeholder="検索" value="' + esc(z.search) + '" '
      + 'autocapitalize="off" autocorrect="off" spellcheck="false">'
      + '<select id="zSort">'
      + '<option value="updated"' + (z.sort === 'updated' ? ' selected' : '') + '>更新順</option>'
      + '<option value="name"' + (z.sort === 'name' ? ' selected' : '') + '>名前順</option>'
      + '<option value="score"' + (z.sort === 'score' ? ' selected' : '') + '>スコア順</option>'
      + '</select></div>';
    html += '<div class="cat-scroll">';
    html += '<button class="chip chip-cat' + (z.cat === 'all' ? ' active' : '') + '" data-zcat="all">すべて</button>';
    for (var i = 0; i < cats.length; i++) {
      html += '<button class="chip chip-cat' + (z.cat === cats[i].id ? ' active' : '') + '" data-zcat="' + esc(cats[i].id) + '">'
        + esc(cats[i].emoji) + ' ' + esc(cats[i].name) + '</button>';
    }
    html += '</div>';
    html += '<div class="filter-row">'
      + '<button class="chip' + (z.filter === 'all' ? ' active' : '') + '" data-zfil="all">すべて</button>'
      + '<button class="chip' + (z.filter === 'like' ? ' active' : '') + '" data-zfil="like">🙂 好き側</button>'
      + '<button class="chip' + (z.filter === 'dislike' ? ' active' : '') + '" data-zfil="dislike">😕 嫌い側</button>'
      + '</div>';
    html += '<div id="zList" class="zukan-list"></div><div id="zSentinel"></div>';
    main.innerHTML = '<section class="screen screen-zukan">' + html + '</section>';
    bindBanners(main);

    var search = document.getElementById('zSearch');
    search.addEventListener('input', function () {
      z.search = search.value;
      z.limit = 100;
      renderZukanList();
    });
    document.getElementById('zSort').addEventListener('change', function (e) {
      z.sort = e.target.value;
      z.limit = 100;
      renderZukanList();
    });
    var zcats = main.querySelectorAll('[data-zcat]');
    for (var j = 0; j < zcats.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          z.cat = btn.getAttribute('data-zcat');
          z.limit = 100;
          renderZukan(main);
        });
      })(zcats[j]);
    }
    var zfils = main.querySelectorAll('[data-zfil]');
    for (var k = 0; k < zfils.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          z.filter = btn.getAttribute('data-zfil');
          z.limit = 100;
          renderZukan(main);
        });
      })(zfils[k]);
    }
    renderZukanList();

    // 100件ずつのチャンク描画+追い読み
    if (state.listObserver) state.listObserver.disconnect();
    if (window.IntersectionObserver) {
      state.listObserver = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && zukanItems().length > z.limit) {
          z.limit += 100;
          renderZukanList();
        }
      });
      state.listObserver.observe(document.getElementById('zSentinel'));
    }
  }

  function renderZukanList() {
    var listBox = document.getElementById('zList');
    if (!listBox) return;
    var items = zukanItems();
    var shown = items.slice(0, state.zukan.limit);
    var html = '';
    for (var i = 0; i < shown.length; i++) {
      var it = shown[i];
      var cat = L.categoryById(state.db, it.categoryId);
      html += '<button class="zukan-row" data-zid="' + esc(it.id) + '">'
        + '<span class="z-emoji">' + (cat ? esc(cat.emoji) : '📦') + '</span>'
        + '<span class="z-name">' + esc(it.name) + '</span>'
        + '<span class="z-pip">' + C.pipSVG(L.itemScore(it)) + '</span>'
        + '<span class="z-time">' + esc(L.relativeDay(it.updatedAt, nowMs(), tzMin())) + '</span></button>';
    }
    if (!items.length) {
      html = '<div class="empty">まだ記録がありません。記録タブから登録してみてください。</div>';
    } else if (items.length > shown.length) {
      html += '<div class="empty">読み込み中… (' + shown.length + '/' + items.length + ')</div>';
    }
    listBox.innerHTML = html;
    var rows = listBox.querySelectorAll('[data-zid]');
    for (var j = 0; j < rows.length; j++) {
      (function (row) {
        row.addEventListener('click', function () { nav('#/zukan/' + row.getAttribute('data-zid')); });
      })(rows[j]);
    }
  }

  // ---- アイテム編集シート ----

  function openSheet(itemId) {
    var item = L.itemById(state.db, itemId);
    var overlay = document.getElementById('overlay');
    if (!item) {
      overlay.className = 'overlay';
      overlay.innerHTML = '';
      return;
    }
    var cats = state.db.categories.slice().sort(function (a, b) { return a.sort - b.sort; });
    var html = '<div class="sheet"><div class="sheet-grab"></div>';
    html += '<div class="sheet-row"><input id="sheetName" type="text" value="' + esc(item.name) + '" '
      + 'autocapitalize="off" autocorrect="off" spellcheck="false"></div>';
    html += '<div class="sheet-scores">';
    for (var i = 0; i < L.SCORES.length; i++) {
      var s = L.SCORES[i];
      var cur = L.itemScore(item) === s.score;
      html += '<button class="score-btn small ' + C.scoreClass(s.score) + '-btn' + (cur ? ' current' : '') + '" data-sscore="' + s.score + '">'
        + '<span class="score-emoji">' + s.emoji + '</span><span class="score-label">' + s.label + '</span></button>';
    }
    html += '</div>';
    html += '<div class="sheet-row"><label class="label">カテゴリ</label><select id="sheetCat">';
    for (var j = 0; j < cats.length; j++) {
      html += '<option value="' + esc(cats[j].id) + '"' + (cats[j].id === item.categoryId ? ' selected' : '') + '>'
        + esc(cats[j].emoji) + ' ' + esc(cats[j].name) + '</option>';
    }
    html += '</select></div>';
    html += '<div class="sheet-row"><label class="label">メモ</label>'
      + '<textarea id="sheetNote" rows="2" placeholder="メモ(任意)">' + esc(item.note) + '</textarea></div>';
    html += '<div class="sheet-row"><div class="label">判定履歴</div><div class="history-list">';
    for (var k = item.history.length - 1; k >= 0; k--) {
      var h = item.history[k];
      var hDef = L.scoreDef(h.score);
      html += '<div class="history-row"><span>' + scoreEmoji(h.score) + ' ' + esc(hDef ? hDef.label : '?') + '</span>'
        + '<span class="history-at">' + esc(String(h.at).slice(0, 16).replace('T', ' ')) + '</span>'
        + (item.history.length > 1
          ? '<button class="btn-mini" data-hdel="' + k + '">削除</button>'
          : '<span class="history-lock">最後の1件</span>')
        + '</div>';
    }
    html += '</div></div>';
    html += '<div class="sheet-row sheet-danger"><button class="btn btn-danger" id="sheetDelete">このアイテムを削除</button>'
      + '<button class="btn btn-secondary" id="sheetClose">閉じる</button></div>';
    html += '</div>';
    overlay.className = 'overlay show sheet-mode';
    overlay.innerHTML = html;

    // 背景タップでの閉鎖は init で1回だけ登録した overlay リスナーが担う(ここで登録すると累積する)
    document.getElementById('sheetClose').addEventListener('click', closeSheetNav);

    var nameEl = document.getElementById('sheetName');
    nameEl.addEventListener('blur', function () { renameItem(itemId, nameEl); });
    nameEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

    document.getElementById('sheetCat').addEventListener('change', function (e) {
      if (guard()) return;
      var items = state.db.items.map(function (it) {
        return it.id === itemId ? L.assign(it, { categoryId: e.target.value }) : it;
      });
      commit(L.assign(state.db, { items: items }), { noRender: true });
    });

    var noteEl = document.getElementById('sheetNote');
    noteEl.addEventListener('blur', function () {
      if (guard()) return;
      var items = state.db.items.map(function (it) {
        return it.id === itemId ? L.assign(it, { note: noteEl.value }) : it;
      });
      commit(L.assign(state.db, { items: items }), { noRender: true });
    });

    var sbtns = overlay.querySelectorAll('[data-sscore]');
    for (var m = 0; m < sbtns.length; m++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          if (guard()) return;
          var cur = L.itemById(state.db, itemId);
          var res = L.applyJudgment(state.db, {
            name: cur.name, categoryId: cur.categoryId,
            score: parseInt(btn.getAttribute('data-sscore'), 10),
            nowIso: nowIso(), nowMs: nowMs(), rand4: rand4()
          });
          if (!res.error) {
            commit(res.db, { noRender: true });
            openSheet(itemId);
            renderTabbar();
          }
        });
      })(sbtns[m]);
    }

    var hdels = overlay.querySelectorAll('[data-hdel]');
    for (var n = 0; n < hdels.length; n++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          if (guard()) return;
          var idx = parseInt(btn.getAttribute('data-hdel'), 10);
          destructive('判定履歴を1件削除しました', function () {
            var items = state.db.items.map(function (it) {
              if (it.id !== itemId) return it;
              var h = it.history.slice(0, idx).concat(it.history.slice(idx + 1));
              return L.assign(it, { history: h, updatedAt: h[h.length - 1].at });
            });
            return commit(L.assign(state.db, { items: items }), { keepUndo: true, noRender: true });
          });
          openSheet(itemId);
        });
      })(hdels[n]);
    }

    document.getElementById('sheetDelete').addEventListener('click', function () {
      if (guard()) return;
      var cur = L.itemById(state.db, itemId);
      dialog({
        title: '削除しますか?',
        body: '<p>「' + esc(cur.name) + '」と判定履歴' + cur.history.length + '件を削除します。</p>',
        buttons: [
          { label: '削除する', cls: 'btn-danger', cb: function () {
            destructive('「' + cur.name + '」を削除しました', function () {
              return commit(L.assign(state.db, {
                items: state.db.items.filter(function (it) { return it.id !== itemId; })
              }), { keepUndo: true, noRender: true });
            });
            closeSheetNav();
          } },
          { label: 'キャンセル', cls: 'btn-secondary' }
        ]
      });
    });

    if (state.pendingNoteFocus) {
      state.pendingNoteFocus = false;
      noteEl.focus();
    }
  }

  function renameItem(itemId, nameEl) {
    if (state.readOnly) return;
    var item = L.itemById(state.db, itemId);
    if (!item) return;
    var newName = nameEl.value.trim().replace(/\s+/g, ' ');
    if (!newName || newName === item.name) { nameEl.value = item.name; return; }
    var norm = L.normalizeName(newName);
    var other = null;
    for (var i = 0; i < state.db.items.length; i++) {
      if (state.db.items[i].id !== itemId && state.db.items[i].norm === norm) other = state.db.items[i];
    }
    if (other) {
      dialog({
        title: '同名のアイテムがあります',
        body: '<p>「' + esc(other.name) + '」(判定' + other.history.length + '件)と統合しますか? 判定履歴は結合されます。</p>',
        buttons: [
          { label: '統合する', cls: 'btn-primary', cb: function () {
            var primary = L.assign(item, { name: newName, norm: norm });
            var merged = L.mergeItems(primary, other);
            var items = state.db.items
              .filter(function (it) { return it.id !== other.id; })
              .map(function (it) { return it.id === itemId ? merged : it; });
            commit(L.assign(state.db, { items: items }), { noRender: true });
            openSheet(itemId);
            toast('統合しました');
          } },
          { label: 'キャンセル', cls: 'btn-secondary', cb: function () { nameEl.value = item.name; } }
        ]
      });
      return;
    }
    var items = state.db.items.map(function (it) {
      return it.id === itemId ? L.assign(it, { name: newName, norm: norm }) : it;
    });
    commit(L.assign(state.db, { items: items }), { noRender: true });
  }

  function closeSheetNav() {
    if (!state.route.itemId) { closeSheet(); return; }
    // 通常は履歴を戻して閉じる(戻るスワイプと同じ経路)。復元直後などで戻り先が
    // 無い場合は hashchange が来ないため、履歴を汚さない replace で脱出する
    var before = location.hash;
    history.back();
    setTimeout(function () {
      if (location.hash === before && state.route.itemId) {
        location.replace(location.href.split('#')[0] + '#/zukan');
      }
    }, 300);
  }

  function closeSheet() {
    var overlay = document.getElementById('overlay');
    overlay.className = 'overlay';
    overlay.innerHTML = '';
    if (state.route.screen === 'zukan') renderZukanList();
    if (state.route.screen === 'record') render();
  }

  function guard() {
    if (state.readOnly) { toast('閲覧専用モードです'); return true; }
    return false;
  }

  // ---- 分析 ----

  function renderStats(main) {
    var unlocks = L.computeUnlocks(state.db);
    var n = state.db.items.length;
    var html = banners();
    var defs = unlocks.cards;
    for (var i = 0; i < defs.length; i++) {
      var card = defs[i];
      if (card.unlocked) html += statsCard(card.key);
      else {
        html += '<div class="card locked-card"><h2>' + esc(card.name) + '</h2>'
          + '<p class="locked-hint">'
          + (card.threshold !== null
            ? 'あと' + (card.threshold - card.current) + '件で解放'
            : esc(card.eventHint))
          + '</p>'
          + (card.threshold !== null ? C.progressSVG(card.current, card.threshold) : '')
          + '</div>';
      }
    }
    // 開拓ログ(常時・最下部)
    html += '<div class="card"><h2>開拓ログ</h2>';
    for (var j = 0; j < defs.length; j++) {
      var d = defs[j];
      html += '<div class="quest-row"><span class="quest-name">' + (d.unlocked ? '✅ ' : '🔒 ') + esc(d.name) + '</span>';
      if (d.unlocked) html += '<span class="quest-state">解放済み</span>';
      else if (d.threshold !== null) html += '<span class="quest-state">' + d.current + '/' + d.threshold + '件</span>' + C.progressSVG(d.current, d.threshold);
      else html += '<span class="quest-state">' + esc(d.eventHint) + '</span>';
      html += '</div>';
    }
    html += '</div>';
    main.innerHTML = '<section class="screen screen-stats">' + html + '</section>';
    bindBanners(main);
    var links = main.querySelectorAll('[data-item]');
    for (var k = 0; k < links.length; k++) {
      (function (el) {
        el.addEventListener('click', function () { nav('#/zukan/' + el.getAttribute('data-item')); });
      })(links[k]);
    }
    // 解放済みカード数を既読化(タブのドットバッジを消す)
    if ((state.db.settings.seenUnlockCount || 0) !== unlocks.unlockedCount && !state.readOnly) {
      state.db = L.assign(state.db, { settings: L.assign(state.db.settings, { seenUnlockCount: unlocks.unlockedCount }) });
      persist();
      renderTabbar();
    }
  }

  function disclaimer(n) {
    return '<p class="caption">n=' + n + '件。記録したものの中での傾向です</p>';
  }

  function statsCard(key) {
    var items = state.db.items;
    var n = items.length;
    if (key === 'gauge') {
      var g = L.computeGauge(items);
      return '<div class="card hero-card"><h2>このみ計</h2>'
        + C.gaugeSVG(g.percent, 'n=' + g.n + '件の記録から')
        + '<p class="caption center">好きに振れているほど100%に近づきます</p></div>';
    }
    if (key === 'hall') {
      var hall = L.computeHallOfFame(items);
      var side = function (title, emoji, list) {
        var s = '<div class="hall-side"><h3>' + emoji + ' ' + title + '</h3>';
        if (!list.length) s += '<p class="caption">まだありません</p>';
        for (var i = 0; i < list.length; i++) {
          s += '<button class="hall-row" data-item="' + esc(list[i].id) + '">' + esc(list[i].name) + '</button>';
        }
        return s + '</div>';
      };
      return '<div class="card"><h2>殿堂とブラックリスト</h2><div class="hall-wrap">'
        + side('殿堂', '😍', hall.best) + side('ブラックリスト', '🤢', hall.worst)
        + '</div>' + disclaimer(n) + '</div>';
    }
    if (key === 'balance') {
      var rows = L.computeCategoryBalance(state.db);
      var maxSide = 1;
      for (var i = 0; i < rows.length; i++) {
        maxSide = Math.max(maxSide, rows[i].counts.m1 + rows[i].counts.m2, rows[i].counts.p1 + rows[i].counts.p2);
      }
      var unit = 150 / maxSide;
      var html = '<div class="card"><h2>カテゴリ別 好悪バランス</h2>' + scoreLegend();
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        html += '<div class="bal-row' + (r.n < 5 ? ' thin' : '') + '">'
          + '<div class="bal-head"><span>' + esc(r.emoji) + ' ' + esc(r.name) + '</span>'
          + '<span class="bal-nums">平均 ' + (r.avg >= 0 ? '+' : '') + r.avg.toFixed(1) + '・' + r.n + '件</span></div>'
          + C.divergingRowSVG(r.counts, unit) + '</div>';
      }
      return html + disclaimer(n) + '</div>';
    }
    if (key === 'clarity') {
      var cl = L.computeClarity(items);
      var html2 = '<div class="card"><h2>はっきり度</h2>' + scoreLegend()
        + C.histogramSVG(cl.counts, ['🤢', '😕', '🙂', '😍'])
        + '<p class="clarity-line">±2率 <strong>' + cl.extremeRate + '%</strong> — ' + cl.label + '</p>'
        + C.meterSVG(cl.extremeRate, 'cap-fill');
      if (cl.asymmetry) html2 += '<p class="clarity-line">' + esc(cl.asymmetry) + '</p>';
      return html2 + disclaimer(cl.n) + '</div>';
    }
    if (key === 'changes') {
      var ch = L.computeChanges(items);
      return '<div class="card"><h2>気変わりタイムライン</h2>'
        + '<div class="legend"><span class="legend-key"><span class="swatch sc-p2"></span>好転</span>'
        + '<span class="legend-key"><span class="swatch sc-m2"></span>幻滅</span>'
        + '<span class="legend-key">左=初回 → 右=最新</span></div>'
        + C.slopeSVG(ch, scoreEmoji)
        + disclaimer(n) + '</div>';
    }
    if (key === 'keywords') {
      var kw = L.computeKeywords(items);
      var cloud = function (list, cls) {
        var s = '';
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          s += '<span class="kw-chip ' + cls + '" style="font-size:' + (13 + Math.min(e.n, 6) * 2) + 'px">'
            + esc(e.gram) + '<sub>' + e.n + '</sub></span>';
        }
        return s || '<p class="caption">まだ見つかりません</p>';
      };
      return '<div class="card"><h2>キーワード傾向</h2>'
        + '<div class="label">好きに多い</div><div class="kw-cloud">' + cloud(kw.top, 'kw-like') + '</div>'
        + '<div class="label">嫌いに多い</div><div class="kw-cloud">' + cloud(kw.bottom, 'kw-dislike') + '</div>'
        + '<p class="caption">アイテム名に3回以上あらわれる2文字のかけらから</p>' + disclaimer(n) + '</div>';
    }
    if (key === 'profile') {
      var pr = L.computeProfile(state.db, nowMs());
      var tiles = '';
      for (var t = 0; t < pr.tiles.length; t++) {
        tiles += '<div class="tile"><div class="tile-label">' + esc(pr.tiles[t].label) + '</div>'
          + '<div class="tile-value">' + esc(pr.tiles[t].value) + '<span class="tile-unit">' + esc(pr.tiles[t].unit) + '</span></div></div>';
      }
      return '<div class="card"><h2>このみプロファイル</h2>'
        + '<p class="profile-text">' + esc(pr.text) + '</p>'
        + '<div class="tile-row">' + tiles + '</div>' + disclaimer(n) + '</div>';
    }
    return '';
  }

  function scoreLegend() {
    return '<div class="legend">'
      + '<span class="legend-key"><span class="swatch sc-m2"></span>🤢 大嫌い</span>'
      + '<span class="legend-key"><span class="swatch sc-m1"></span>😕 苦手</span>'
      + '<span class="legend-key"><span class="swatch sc-p1"></span>🙂 好き</span>'
      + '<span class="legend-key"><span class="swatch sc-p2"></span>😍 大好き</span>'
      + '</div>';
  }

  // ---- 設定 ----

  function renderSettings(main) {
    var db = state.db;
    var raw = '';
    try { raw = localStorage.getItem(KEY_DB) || ''; } catch (e) { raw = ''; }
    var st = L.storageInfo(raw.length);
    var days = L.daysSince(db.settings.lastBackupAt, nowMs());
    var cats = db.categories.slice().sort(function (a, b) { return a.sort - b.sort; });

    var html = banners();
    html += '<div class="card"><h2>カテゴリ管理</h2><div class="cat-list">';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      var count = 0;
      for (var j = 0; j < db.items.length; j++) if (db.items[j].categoryId === c.id) count++;
      html += '<div class="cat-row"><span class="cat-row-name">' + esc(c.emoji) + ' ' + esc(c.name)
        + ' <span class="caption">(' + count + ')</span></span>'
        + '<span class="cat-row-btns">'
        + '<button class="btn-mini" data-cup="' + esc(c.id) + '">↑</button>'
        + '<button class="btn-mini" data-cdown="' + esc(c.id) + '">↓</button>'
        + '<button class="btn-mini" data-cmenu="' + esc(c.id) + '">⋯</button>'
        + '</span></div>';
    }
    html += '</div><button class="btn btn-secondary" id="catAdd">+ カテゴリを追加</button></div>';

    html += '<div class="card"><h2>バックアップ</h2>'
      + '<p>' + (days === null ? 'まだ書き出していません' : '最終バックアップ: ' + days + '日前')
      + '・未保存の変更 ' + (db.settings.dirtySinceBackup || 0) + '件</p>'
      + '<div class="btn-row"><button class="btn btn-primary" id="exportBtn">書き出す</button>'
      + '<button class="btn btn-secondary" id="importBtn">取り込む</button></div>'
      + '<input type="file" id="importFile" accept=".json,application/json" hidden>'
      + '<p class="caption">「エクスポート → インポート」で完全に元どおりになります(置き換え方式)</p></div>';

    html += '<div class="card"><h2>ストレージ</h2>'
      + C.meterSVG(st.percent, 'cap-fill')
      + '<p class="caption">' + st.kb + ' KB / 目安 5 MB(' + st.percent + '%)。'
      + 'このオリジンは他ツール(めぐり・そらコンパス等)と共有です</p></div>';

    html += '<div class="card"><h2>注意</h2>'
      + '<p class="caption">・Safari の「履歴と Web サイトデータを消去」でこのアプリのデータも消えます<br>'
      + '・ホーム画面版と Safari 版はデータ領域が別です<br>'
      + '・分析は記録したものの中での傾向です</p></div>';

    html += '<div class="card danger-card"><h2>データの全削除</h2>'
      + '<button class="btn btn-danger" id="wipeBtn">すべての記録を削除</button></div>';

    html += '<p class="caption center">このみ ' + VERSION + '</p>';

    main.innerHTML = '<section class="screen screen-settings">' + html + '</section>';
    bindBanners(main);

    document.getElementById('catAdd').addEventListener('click', addCategoryDialog);
    bindCatButtons(main);
    document.getElementById('exportBtn').addEventListener('click', doExport);
    var fileEl = document.getElementById('importFile');
    document.getElementById('importBtn').addEventListener('click', function () {
      importDialog(fileEl);
    });
    fileEl.addEventListener('change', function () {
      if (fileEl.files && fileEl.files[0]) {
        var reader = new FileReader();
        reader.onload = function () { processImport(String(reader.result)); };
        reader.readAsText(fileEl.files[0]);
        fileEl.value = '';
      }
    });
    document.getElementById('wipeBtn').addEventListener('click', wipeDialog);
  }

  function bindCatButtons(root) {
    var move = function (id, dir) {
      if (guard()) return;
      var cats = state.db.categories.slice().sort(function (a, b) { return a.sort - b.sort; });
      var idx = -1;
      for (var i = 0; i < cats.length; i++) if (cats[i].id === id) idx = i;
      var swap = idx + dir;
      if (idx < 0 || swap < 0 || swap >= cats.length) return;
      var a = cats[idx];
      var b = cats[swap];
      var newCats = state.db.categories.map(function (c) {
        if (c.id === a.id) return L.assign(c, { sort: b.sort });
        if (c.id === b.id) return L.assign(c, { sort: a.sort });
        return c;
      });
      commit(L.assign(state.db, { categories: newCats }));
    };
    var ups = root.querySelectorAll('[data-cup]');
    for (var i = 0; i < ups.length; i++) {
      (function (el) { el.addEventListener('click', function () { move(el.getAttribute('data-cup'), -1); }); })(ups[i]);
    }
    var downs = root.querySelectorAll('[data-cdown]');
    for (var j = 0; j < downs.length; j++) {
      (function (el) { el.addEventListener('click', function () { move(el.getAttribute('data-cdown'), 1); }); })(downs[j]);
    }
    var menus = root.querySelectorAll('[data-cmenu]');
    for (var k = 0; k < menus.length; k++) {
      (function (el) { el.addEventListener('click', function () { categoryMenu(el.getAttribute('data-cmenu')); }); })(menus[k]);
    }
  }

  function addCategoryDialog() {
    if (guard()) return;
    dialog({
      title: 'カテゴリを追加',
      body: '<input id="dlgCatName" type="text" placeholder="名前(例: 映画)" class="dlg-input">'
        + '<input id="dlgCatEmoji" type="text" placeholder="絵文字1文字(例: 🎬)" class="dlg-input">',
      buttons: [
        { label: '追加', cls: 'btn-primary', keep: true, cb: function () {
          var name = document.getElementById('dlgCatName').value.trim();
          var emoji = document.getElementById('dlgCatEmoji').value.trim() || '🏷';
          if (!name) { toast('名前を入力してください'); return; }
          var maxSort = 0;
          for (var i = 0; i < state.db.categories.length; i++) {
            if (state.db.categories[i].sort < 900) maxSort = Math.max(maxSort, state.db.categories[i].sort);
          }
          var cat = {
            id: L.genId('c', nowMs(), rand4()), name: name, emoji: emoji,
            preset: false, sort: maxSort + 10, createdAt: nowIso()
          };
          closeDialog();
          commit(L.assign(state.db, { categories: state.db.categories.concat([cat]) }));
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  function categoryMenu(catId) {
    if (guard()) return;
    var cat = L.categoryById(state.db, catId);
    if (!cat) return;
    var count = 0;
    for (var i = 0; i < state.db.items.length; i++) if (state.db.items[i].categoryId === catId) count++;
    dialog({
      title: cat.emoji + ' ' + cat.name,
      body: '<p class="caption">所属アイテム: ' + count + '件</p>',
      buttons: [
        { label: '改名', cls: 'btn-secondary', cb: function () { renameCategoryDialog(catId); } },
        { label: '絵文字を変更', cls: 'btn-secondary', cb: function () { emojiCategoryDialog(catId); } },
        { label: '別カテゴリへ統合', cls: 'btn-secondary', cb: function () { mergeCategoryDialog(catId); } },
        { label: '削除', cls: 'btn-danger', cb: function () { deleteCategoryDialog(catId, count); } },
        { label: '閉じる', cls: 'btn-secondary' }
      ]
    });
  }

  function renameCategoryDialog(catId) {
    var cat = L.categoryById(state.db, catId);
    dialog({
      title: 'カテゴリを改名',
      body: '<input id="dlgCatName" type="text" value="' + esc(cat.name) + '" class="dlg-input">',
      buttons: [
        { label: '保存', cls: 'btn-primary', keep: true, cb: function () {
          var name = document.getElementById('dlgCatName').value.trim();
          if (!name) { toast('名前を入力してください'); return; }
          closeDialog();
          commit(L.assign(state.db, {
            categories: state.db.categories.map(function (c) {
              return c.id === catId ? L.assign(c, { name: name }) : c;
            })
          }));
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  function emojiCategoryDialog(catId) {
    var cat = L.categoryById(state.db, catId);
    dialog({
      title: '絵文字を変更',
      body: '<input id="dlgCatEmoji" type="text" value="' + esc(cat.emoji) + '" class="dlg-input">',
      buttons: [
        { label: '保存', cls: 'btn-primary', keep: true, cb: function () {
          var emoji = document.getElementById('dlgCatEmoji').value.trim();
          if (!emoji) { toast('絵文字を入力してください'); return; }
          closeDialog();
          commit(L.assign(state.db, {
            categories: state.db.categories.map(function (c) {
              return c.id === catId ? L.assign(c, { emoji: emoji }) : c;
            })
          }));
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  function mergeCategoryDialog(fromId) {
    var from = L.categoryById(state.db, fromId);
    var others = state.db.categories.filter(function (c) { return c.id !== fromId; })
      .sort(function (a, b) { return a.sort - b.sort; });
    if (!others.length) { toast('統合先がありません'); return; }
    var count = 0;
    for (var i = 0; i < state.db.items.length; i++) if (state.db.items[i].categoryId === fromId) count++;
    var buttons = others.map(function (o) {
      return { label: o.emoji + ' ' + o.name + ' へ', cls: 'btn-secondary', cb: function () {
        dialog({
          title: '統合しますか?',
          body: '<p>「' + esc(from.name) + '」の' + count + '件を「' + esc(o.name) + '」へ移動し、「' + esc(from.name) + '」を削除します。</p>',
          buttons: [
            { label: '統合する', cls: 'btn-primary', cb: function () {
              destructive('カテゴリを統合しました', function () {
                var res = L.mergeCategory(state.db, fromId, o.id);
                return commit(res.db, { keepUndo: true });
              });
            } },
            { label: 'キャンセル', cls: 'btn-secondary' }
          ]
        });
      } };
    });
    buttons.push({ label: 'キャンセル', cls: 'btn-secondary' });
    dialog({ title: '統合先を選択', body: '', buttons: buttons });
  }

  function deleteCategoryDialog(catId, count) {
    var cat = L.categoryById(state.db, catId);
    // 未分類自身は「未分類へ移動」できない(孤児参照が残る)ため削除のみ提示
    if (catId === L.MISC_CATEGORY.id) {
      dialog({
        title: 'カテゴリを削除',
        body: '<p>「' + esc(cat.name) + '」には' + count + '件のアイテムがあります。未分類は移動先にできないため、削除する場合はアイテムごと削除になります。</p>',
        buttons: [
          { label: 'アイテムごと削除', cls: 'btn-danger', cb: function () {
            destructive('カテゴリとアイテム' + count + '件を削除しました', function () {
              var res = L.deleteCategory(state.db, catId, 'purge', nowIso());
              return commit(res.db, { keepUndo: true });
            });
          } },
          { label: 'キャンセル', cls: 'btn-secondary' }
        ]
      });
      return;
    }
    dialog({
      title: 'カテゴリを削除',
      body: '<p>「' + esc(cat.name) + '」には' + count + '件のアイテムがあります。どうしますか?</p>',
      buttons: [
        { label: 'アイテムは未分類へ移動', cls: 'btn-primary', cb: function () {
          destructive('カテゴリを削除しました(アイテムは未分類へ)', function () {
            var res = L.deleteCategory(state.db, catId, 'move', nowIso());
            return commit(res.db, { keepUndo: true });
          });
        } },
        { label: 'アイテムごと削除', cls: 'btn-danger', cb: function () {
          destructive('カテゴリとアイテム' + count + '件を削除しました', function () {
            var res = L.deleteCategory(state.db, catId, 'purge', nowIso());
            return commit(res.db, { keepUndo: true });
          });
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  // ---- エクスポート / インポート ----

  function doExport() {
    var envelope = L.buildExport(state.db, nowIso());
    var json = JSON.stringify(envelope);
    var name = 'konomi-backup-' + nowIso().slice(0, 10).replace(/-/g, '') + '.json';
    var markDone = function () {
      if (state.readOnly) return; // 閲覧専用でもエクスポートは許可(記録はしない)
      state.db = L.assign(state.db, {
        settings: L.assign(state.db.settings, { lastBackupAt: nowIso(), dirtySinceBackup: 0 })
      });
      persist();
      render();
    };
    var shared = false;
    if (navigator.canShare && window.File) {
      try {
        var file = new File([json], name, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          shared = true;
          navigator.share({ files: [file] }).then(function () {
            markDone();
            toast('書き出しました');
          }, function () { /* キャンセルは何もしない */ });
        }
      } catch (e) { shared = false; }
    }
    if (!shared) {
      var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      dialog({
        title: 'バックアップを書き出す',
        body: '<p><a class="btn btn-primary dl-btn" href="' + url + '" download="' + esc(name) + '" id="dlLink">ファイルを保存</a></p>'
          + '<textarea readonly class="export-text" id="exportText"></textarea>',
        buttons: [
          { label: '全文コピー', cls: 'btn-secondary', keep: true, cb: function () { copyText(json); markDone(); } },
          { label: '閉じる', cls: 'btn-secondary', cb: function () { URL.revokeObjectURL(url); } }
        ],
        onOpen: function (overlay) {
          document.getElementById('exportText').value = json;
          document.getElementById('dlLink').addEventListener('click', function () {
            setTimeout(function () { markDone(); toast('書き出しました'); }, 100);
          });
        }
      });
    }
  }

  function importDialog(fileEl) {
    if (guard()) return;
    dialog({
      title: 'バックアップを取り込む',
      body: '<p class="caption">現在のデータは「置き換え」になります(直前の状態は自動退避)。</p>'
        + '<textarea id="importText" class="export-text" placeholder="ここに JSON を貼り付け"></textarea>',
      buttons: [
        { label: 'ファイルを選択', cls: 'btn-primary', cb: function () { fileEl.click(); } },
        { label: '貼り付け内容を読み込む', cls: 'btn-secondary', keep: true, cb: function () {
          var text = document.getElementById('importText').value;
          if (!text.trim()) { toast('JSON を貼り付けてください'); return; }
          closeDialog();
          processImport(text);
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  function processImport(text) {
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      dialog({ title: '読み込めません', body: '<p>JSON として解釈できませんでした。</p>', buttons: [{ label: '閉じる', cls: 'btn-secondary' }] });
      return;
    }
    var res;
    try {
      res = L.validateImport(parsed, nowIso());
    } catch (e2) {
      // 構造が想定外でも無言で終わらせない
      dialog({ title: '取り込めません', body: '<p>データの構造を解釈できませんでした(' + esc(e2.message) + ')</p>', buttons: [{ label: '閉じる', cls: 'btn-secondary' }] });
      return;
    }
    if (!res.ok) {
      dialog({ title: '取り込めません', body: '<p>' + esc(res.fatal) + '</p>', buttons: [{ label: '閉じる', cls: 'btn-secondary' }] });
      return;
    }
    var incoming = res.db;
    var body = '<p>取り込むデータ: カテゴリ' + incoming.categories.length + '・アイテム' + incoming.items.length
      + '(現在: カテゴリ' + state.db.categories.length + '・アイテム' + state.db.items.length + ')</p>';
    if (parsed.exported_at) body += '<p class="caption">書き出し日時: ' + esc(parsed.exported_at) + '</p>';
    if (res.report.orphaned) body += '<p class="caption">カテゴリ不明のアイテム' + res.report.orphaned + '件は未分類に移動します</p>';
    if (res.report.dropped) body += '<p class="caption">判定のない不正アイテム' + res.report.dropped + '件は取り込みません</p>';
    for (var i = 0; i < res.warnings.length; i++) body += '<p class="caption">⚠ ' + esc(res.warnings[i]) + '</p>';
    dialog({
      title: '置き換えますか?',
      body: body,
      buttons: [
        { label: '置き換える', cls: 'btn-danger', cb: function () {
          try {
            var cur = localStorage.getItem(KEY_DB);
            if (cur !== null) localStorage.setItem(KEY_PREIMPORT, cur);
          } catch (e) { /* 退避失敗でも続行 */ }
          state.db = incoming;
          persist();
          render();
          toast('取り込みました');
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  function wipeDialog() {
    if (guard()) return;
    dialog({
      title: 'すべての記録を削除',
      body: '<p>アイテム' + state.db.items.length + '件と判定履歴のすべてを削除します。まず書き出しておくことを強くおすすめします。</p>',
      buttons: [
        { label: '書き出してから', cls: 'btn-primary', cb: doExport },
        { label: '削除に進む', cls: 'btn-danger', cb: function () {
          dialog({
            title: '本当に削除しますか?',
            body: '<p>この操作は取り消せません。</p>',
            buttons: [
              { label: '完全に削除する', cls: 'btn-danger', cb: function () {
                try {
                  var doomed = [];
                  for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('konomi.') === 0) doomed.push(k);
                  }
                  for (var j = 0; j < doomed.length; j++) localStorage.removeItem(doomed[j]);
                } catch (e) { /* 続行 */ }
                state.db = L.makeEmptyDb(nowIso());
                state.undoSlot = null;
                persist();
                render();
                toast('すべて削除しました');
              } },
              { label: 'キャンセル', cls: 'btn-secondary' }
            ]
          });
        } },
        { label: 'キャンセル', cls: 'btn-secondary' }
      ]
    });
  }

  // ---- キーボード追従(visualViewport) ----

  function setupViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var update = function () {
      var dock = document.getElementById('scoreDock');
      if (!dock) return;
      var kb = window.innerHeight - vv.height - vv.offsetTop;
      if (kb > 40) dock.style.bottom = kb + 'px';
      else dock.style.bottom = '';
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }

  // ---- Service Worker ----

  function setupSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('新しいバージョンがあります', [
              { label: '更新', cb: function () {
                state.session.updateRequested = true;
                w.postMessage({ type: 'SKIP_WAITING' });
              } }
            ], 15000);
          }
        });
      });
    }, function () { /* 登録失敗は無視(オフライン初回など) */ });
    // 初回インストール時の clients.claim() でも controllerchange は発火する。
    // リロードは「更新」タップ後のみ(初回に入力中の内容を吹き飛ばさない)
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!state.session.updateRequested || state.session.reloading) return;
      state.session.reloading = true;
      location.reload();
    });
  }

  // ---- 起動 ----

  function init() {
    loadDb();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () { });
    }
    state.route = parseHash();
    if (!location.hash) {
      try { history.replaceState(null, '', '#/record'); } catch (e) { location.hash = '#/record'; }
      state.route = { screen: 'record', itemId: null };
    }
    window.addEventListener('hashchange', onHashChange);
    // シート背景タップの閉鎖はここで1回だけ登録(openSheet 内で登録すると累積し
    // history.back() が多重実行される。ダイアログは背景タップで閉じない=対象外)
    document.getElementById('overlay').addEventListener('click', function (e) {
      if (e.target !== e.currentTarget) return;
      if (e.currentTarget.className.indexOf('sheet-mode') >= 0) closeSheetNav();
    });
    render();
    setupViewport();
    setupSW();
  }

  return { init: init, _state: state };
})();

document.addEventListener('DOMContentLoaded', KONOMI.app.init);
