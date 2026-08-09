// このみ — logic.js / charts.js の JXA ユニットテスト(node 不使用)
// 実行: osascript -l JavaScript test/test_logic.js (test/run.sh から呼ばれる)
ObjC.import('Foundation');
ObjC.import('stdlib');

function readText(path) {
  return $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
}

eval(readText('js/logic.js'));
eval(readText('js/charts.js'));

var L = KONOMI.logic;
var C = KONOMI.charts;

var failures = 0;
var total = 0;

function eq(actual, expected, label) {
  total++;
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log('NG: ' + label + '\n  期待: ' + e + '\n  実際: ' + a);
}

function ok(cond, label) {
  total++;
  if (cond) return;
  failures++;
  console.log('NG: ' + label);
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

var TZ = -540; // JST
var T0 = Date.parse('2026-08-09T12:00:00+09:00');

function iso(offsetSec) { return L.toIso(T0 + (offsetSec || 0) * 1000, TZ); }

// ---- normalizeName ----
eq(L.normalizeName('  ラーメン  '), 'らーめん', '正規化: trim+カタカナ→ひらがな');
eq(L.normalizeName('ｶﾚｰ'), 'かれー', '正規化: NFKC 半角カタカナ(長音は残す)');
eq(L.normalizeName('ＡＢＣ'), 'abc', '正規化: 全角英字→小文字');
eq(L.normalizeName('担々麺'), '担々麺', '正規化: 漢字はそのまま');
eq(L.normalizeName('抹茶  ラテ'), '抹茶 らて', '正規化: 連続空白圧縮');
eq(L.normalizeName(''), '', '正規化: 空文字');
eq(L.normalizeName('ヴィーガン'), 'ゔぃーがん', '正規化: ヴ も変換');

// ---- toIso ----
eq(L.toIso(T0, TZ), '2026-08-09T12:00:00+09:00', 'toIso: JST');
eq(L.toIso(T0, 0), '2026-08-09T03:00:00+00:00', 'toIso: UTC');

// ---- genId ----
var id1 = L.genId('i', T0, 'ab12');
ok(/^i_[0-9a-z]+_ab12$/.test(id1), 'genId 形式: ' + id1);

// ---- makeEmptyDb / seed ----
var db = L.makeEmptyDb(iso(0));
eq(db.schema_version, 1, '初期DB: schema_version');
eq(db.categories.length, 6, '初期DB: プリセット6種(未分類は遅延生成)');
eq(db.items.length, 0, '初期DB: items 空');
eq(db.settings.lastCategoryId, 'c_preset_food', '初期DB: 既定カテゴリ');

// ---- applyJudgment: 新規作成 ----
var r1 = L.applyJudgment(db, { name: ' ラーメン ', categoryId: 'c_preset_food', score: 2, nowIso: iso(0), nowMs: T0, rand4: 'aaaa' });
ok(!r1.error, '新規判定: エラーなし');
eq(r1.created, true, '新規判定: created');
eq(r1.db.items.length, 1, '新規判定: 1件追加');
eq(r1.db.items[0].name, 'ラーメン', '新規判定: 名前は trim のみ(表示用)');
eq(r1.db.items[0].norm, 'らーめん', '新規判定: norm');
eq(r1.db.items[0].history.length, 1, '新規判定: history 1件');
eq(L.itemScore(r1.db.items[0]), 2, '新規判定: 現在スコア');
eq(db.items.length, 0, '純粋性: 元の db は不変');

// ---- applyJudgment: 再判定(norm 一致・カテゴリ横断) ----
var r2 = L.applyJudgment(r1.db, { name: 'らーめん', categoryId: 'c_preset_drink', score: -1, nowIso: iso(60), nowMs: T0 + 60000, rand4: 'bbbb' });
eq(r2.created, false, '再判定: created=false');
eq(r2.db.items.length, 1, '再判定: 件数不変(重複を作らない)');
eq(r2.db.items[0].history.length, 2, '再判定: history 追記');
eq(L.itemScore(r2.db.items[0]), -1, '再判定: 現在スコアは最新');
eq(r2.db.items[0].categoryId, 'c_preset_food', '再判定: カテゴリは既存のまま');
eq(r2.db.settings.lastCategoryId, 'c_preset_food', '再判定: lastCategoryId は既存カテゴリ');

// ---- applyJudgment: 不正入力 ----
eq(L.applyJudgment(db, { name: '   ', categoryId: 'c_preset_food', score: 2, nowIso: iso(0), nowMs: T0, rand4: 'cccc' }).error, 'empty', '空名は拒否');
eq(L.applyJudgment(db, { name: 'a', categoryId: 'c_preset_food', score: 0, nowIso: iso(0), nowMs: T0, rand4: 'cccc' }).error, 'badscore', 'score 0 は拒否');

// ---- undoJudgment ----
var u1 = L.undoJudgment(r1.db, r1.undo);
eq(u1.items.length, 0, 'undo: 新規作成は item ごと削除');
var u2 = L.undoJudgment(r2.db, r2.undo);
eq(u2.items[0].history.length, 1, 'undo: 再判定は末尾削除');
eq(u2.items[0].updatedAt, iso(0), 'undo: updatedAt 巻き戻し');

// ---- capHistory ----
var longHist = [];
for (var i = 0; i < 25; i++) longHist.push({ score: 1, at: iso(i) });
var capped = L.capHistory(longHist);
eq(capped.length, 20, 'capHistory: 上限20');
eq(capped[0].at, iso(0), 'capHistory: 最初の1件を保全');
eq(capped[1].at, iso(6), 'capHistory: 2件目=最新19件の先頭');
eq(capped[19].at, iso(24), 'capHistory: 末尾は最新');

// ---- suggest ----
var db3 = db;
var names = [['ラーメン', 2], ['担々麺', 1], ['冷やしラーメン', 1], ['カレー', -1], ['ラー油', -2]];
for (var j = 0; j < names.length; j++) {
  db3 = L.applyJudgment(db3, { name: names[j][0], categoryId: 'c_preset_food', score: names[j][1], nowIso: iso(j * 10), nowMs: T0 + j * 10000, rand4: 'x' + j + 'zz' }).db;
}
var sug = L.suggest('ラーメ', db3.items, 5);
eq(sug[0].name, 'ラーメン', 'suggest: 前方一致が先頭');
ok(sug.length >= 2, 'suggest: 部分一致も拾う');
var sugNames = sug.map(function (s) { return s.name; });
ok(sugNames.indexOf('冷やしラーメン') >= 0, 'suggest: 部分一致(冷やしラーメン)');
eq(L.suggest('', db3.items, 5).length, 0, 'suggest: 空クエリは空');

// ---- findByNorm ----
ok(L.findByNorm(db3.items, 'らーめん') !== null, 'findByNorm: ひらがな照合');
ok(L.findByNorm(db3.items, '存在しない') === null, 'findByNorm: 不在は null');

// ---- recentItems ----
var rec = L.recentItems(db3.items, 3);
eq(rec[0].name, 'ラー油', 'recentItems: 最新順');
eq(rec.length, 3, 'recentItems: 件数');

// ---- mergeItems ----
var itemA = { id: 'i_a', categoryId: 'c_preset_food', name: 'コーヒー', norm: 'こーひー', note: '',
  history: [{ score: 1, at: iso(0) }, { score: 2, at: iso(100) }], createdAt: iso(0), updatedAt: iso(100) };
var itemB = { id: 'i_b', categoryId: 'c_preset_drink', name: 'こーひー', norm: 'こーひー', note: '深煎り',
  history: [{ score: -1, at: iso(50) }, { score: 1, at: iso(0) }], createdAt: iso(50), updatedAt: iso(50) };
var merged = L.mergeItems(itemA, itemB);
eq(merged.history.length, 3, 'mergeItems: at+score 同値重複排除(iso(0),score1 が重複)');
eq(merged.history[0].at, iso(0), 'mergeItems: at 昇順');
eq(merged.note, '深煎り', 'mergeItems: note は空なら相手側');
eq(merged.updatedAt, iso(100), 'mergeItems: updatedAt は結合後末尾');
eq(merged.createdAt, iso(0), 'mergeItems: createdAt は古い方');
eq(merged.categoryId, 'c_preset_food', 'mergeItems: カテゴリは primary');

// ---- mergeCategory / deleteCategory ----
var mc = L.mergeCategory(db3, 'c_preset_food', 'c_preset_drink');
eq(mc.moved, 5, 'mergeCategory: 移動件数');
eq(mc.db.categories.length, 5, 'mergeCategory: 統合元は削除');
eq(mc.db.settings.lastCategoryId, 'c_preset_drink', 'mergeCategory: lastCategoryId 付替え');

var dcMove = L.deleteCategory(db3, 'c_preset_food', 'move', iso(0));
eq(dcMove.affected, 5, 'deleteCategory(move): 対象件数');
ok(L.categoryById(dcMove.db, 'c_preset_misc') !== null, 'deleteCategory(move): 未分類を遅延生成');
eq(dcMove.db.items.filter(function (it) { return it.categoryId === 'c_preset_misc'; }).length, 5, 'deleteCategory(move): 未分類へ移動');

var dcPurge = L.deleteCategory(db3, 'c_preset_food', 'purge', iso(0));
eq(dcPurge.db.items.length, 0, 'deleteCategory(purge): アイテムごと削除');

// ---- fnv1a / checksum ----
eq(L.fnv1a(''), '811c9dc5', 'fnv1a: 空文字の既知値');
eq(L.fnv1a('a'), 'e40c292c', 'fnv1a: "a" の既知値');
ok(/^[0-9a-f]{8}$/.test(L.checksumOf(db3)), 'checksum: 8桁hex');

// ---- buildExport / validateImport ラウンドトリップ ----
var env = L.buildExport(db3, iso(999));
eq(env.app, 'konomi', 'export: app');
eq(env.counts.items, 5, 'export: counts.items');
eq(env.counts.judgments, 5, 'export: counts.judgments');
eq(env.data.settings.dirtySinceBackup, 0, 'export: 督促カウンタをリセットして書き出す');
eq(env.data.settings.lastBackupAt, iso(999), 'export: lastBackupAt を埋め込む');
var vi = L.validateImport(clone(env), iso(1000));
ok(vi.ok, 'import: エンベロープ受理');
eq(vi.warnings.length, 0, 'import: 警告なし');
var expected = L.assign(db3, { settings: L.assign(db3.settings, { lastBackupAt: iso(999), dirtySinceBackup: 0 }) });
eq(JSON.stringify(vi.db), JSON.stringify(expected), 'import: 往復 deep-equal(督促カウンタ以外無損失)');

// 生 db 直接インポート(エンベロープなし)
var viRaw = L.validateImport(clone(db3), iso(1000));
ok(viRaw.ok, 'import: 生 db も受理');
eq(viRaw.warnings.length, 1, 'import: エンベロープなし警告');

// 改ざん検知
var tampered = clone(env);
tampered.data.items[0].name = '改ざん';
var viBad = L.validateImport(tampered, iso(1000));
eq(viBad.ok, false, 'import: チェックサム不一致は拒否');

// 他アプリ拒否・未来版拒否
eq(L.validateImport({ app: 'other', data: {} }, iso(0)).ok, false, 'import: 他アプリ拒否');
var future = clone(env);
future.data.schema_version = 99;
future.checksum = L.checksumOf(future.data);
eq(L.validateImport(future, iso(0)).ok, false, 'import: 未来版拒否');

// 孤児修復
var orphanEnv = clone(env);
orphanEnv.data.items[0].categoryId = 'c_ghost';
orphanEnv.checksum = L.checksumOf(orphanEnv.data);
var viOrphan = L.validateImport(orphanEnv, iso(0));
ok(viOrphan.ok, 'import: 孤児あっても受理');
eq(viOrphan.report.orphaned, 1, 'import: 孤児1件報告');
eq(viOrphan.db.items[0].categoryId, 'c_preset_misc', 'import: 孤児は未分類へ');
ok(L.categoryById(viOrphan.db, 'c_preset_misc') !== null, 'import: 未分類を生成');

// 空 history 除外
var emptyEnv = clone(env);
emptyEnv.data.items[0].history = [];
emptyEnv.checksum = L.checksumOf(emptyEnv.data);
var viEmpty = L.validateImport(emptyEnv, iso(0));
eq(viEmpty.report.dropped, 1, 'import: 空 history は除外報告');
eq(viEmpty.db.items.length, 4, 'import: 除外後件数');

// null 要素・型不正 history の防御
var nullEnv = clone(env);
nullEnv.data.items = [null, clone(env.data.items[0])];
nullEnv.data.items[1].history = [
  { score: 0, at: iso(0) },      // 不正スコア(4段階に無い)
  { score: 2, at: 12345 },       // at が文字列でない
  { score: 1, at: iso(10) }      // 正常
];
nullEnv.data.categories = nullEnv.data.categories.concat([null, { name: 'idなし' }]);
nullEnv.checksum = L.checksumOf(nullEnv.data);
var viNull = L.validateImport(nullEnv, iso(0));
ok(viNull.ok, 'import: null 要素があっても受理');
eq(viNull.report.dropped, 1, 'import: null item は除外');
eq(viNull.db.items.length, 1, 'import: 残存1件');
eq(viNull.db.items[0].history.length, 1, 'import: 不正 score/at の履歴を除去');
eq(viNull.db.items[0].history[0].score, 1, 'import: 正常履歴のみ残る');
eq(viNull.db.categories.length, 6, 'import: 不正カテゴリ要素は除去');

// schema_version 下限
eq(L.validateImport({ app: 'konomi', schema_version: 0, categories: [], items: [] }, iso(0)).ok, false, 'import: 版0は拒否');
eq(L.validateImport({ app: 'konomi', schema_version: 0.5, categories: [], items: [] }, iso(0)).ok, false, 'import: 小数版は拒否');

// オフセット混在の時系列保全(文字列順では逆転するケース)
var tzItem = {
  id: 'i_tz', categoryId: 'c_preset_food', name: 'タイムゾーン', norm: 'たいむぞーん', note: '',
  history: [
    { score: -2, at: '2026-08-01T09:00:00+09:00' },  // 実時刻 00:00Z(先)
    { score: 2, at: '2026-08-01T01:00:00+00:00' }    // 実時刻 01:00Z(後)。文字列比較だとこちらが先になる
  ],
  createdAt: '2026-08-01T09:00:00+09:00', updatedAt: '2026-08-01T01:00:00+00:00'
};
var tzEnv = L.buildExport(L.assign(db3, { items: [tzItem] }), iso(999));
var viTz = L.validateImport(clone(tzEnv), iso(1000));
eq(L.itemScore(viTz.db.items[0]), 2, 'import: オフセット混在でも実時刻順(現在スコアが反転しない)');
eq(viTz.db.items[0].history[0].score, -2, 'import: 始点も実時刻順');

// ---- cmpIso ----
ok(L.cmpIso('2026-08-01T09:00:00+09:00', '2026-08-01T01:00:00+00:00') < 0, 'cmpIso: 実時刻比較');
ok(L.cmpIso('b', 'a') > 0, 'cmpIso: 不正時刻は文字列比較へフォールバック');

// ---- migrate ----
eq(L.migrate(clone(db3)).migrated, false, 'migrate: 現行版は無変換');

// ---- deleteCategory: 未分類の move 削除ガード ----
var dbm = L.ensureMisc(db3, iso(0));
eq(L.deleteCategory(dbm, 'c_preset_misc', 'move', iso(0)).error, 'misc_move', 'deleteCategory: 未分類のmove削除は拒否');
eq(L.deleteCategory(dbm, 'c_preset_misc', 'purge', iso(0)).error, undefined, 'deleteCategory: 未分類のpurgeは可');

// ---- backupDue ----
ok(!L.backupDue({ lastBackupAt: iso(0), dirtySinceBackup: 9 }, T0), 'backupDue: 変更9件は対象外');
ok(L.backupDue({ lastBackupAt: null, dirtySinceBackup: 10 }, T0), 'backupDue: 未バックアップ+10件');
ok(!L.backupDue({ lastBackupAt: iso(-13 * 86400), dirtySinceBackup: 10 }, T0), 'backupDue: 13日は対象外');
ok(L.backupDue({ lastBackupAt: iso(-15 * 86400), dirtySinceBackup: 10 }, T0), 'backupDue: 15日+10件');
ok(L.backupDue({ lastBackupAt: iso(0), dirtySinceBackup: 50 }, T0), 'backupDue: 50件は日数不問');

// ---- relativeDay ----
eq(L.relativeDay(iso(0), T0, TZ), '今日', 'relativeDay: 今日');
eq(L.relativeDay(iso(-86400), T0, TZ), '昨日', 'relativeDay: 昨日');
eq(L.relativeDay(iso(-3 * 86400), T0, TZ), '3日前', 'relativeDay: n日前');
eq(L.relativeDay('2026-01-01T00:00:00+09:00', T0, TZ), '2026/1/1', 'relativeDay: 31日以上は日付');

// ---- storageInfo ----
eq(L.storageInfo(1024).kb, 2, 'storageInfo: UTF-16換算');

// ---- 分析 ----
var g = L.computeGauge(db3.items);
eq(g.n, 5, 'gauge: n');
// スコア: +2,+1,+1,-1,-2 → 平均 0.2 → (0.2+2)/4 = 55%
eq(g.percent, 55, 'gauge: 陽性度');
eq(L.computeGauge([]), null, 'gauge: 0件は null');

var hall = L.computeHallOfFame(db3.items);
eq(hall.best.length, 1, 'hall: 殿堂1件');
eq(hall.best[0].name, 'ラーメン', 'hall: 殿堂の中身');
eq(hall.worst.length, 1, 'hall: ブラックリスト1件');
eq(hall.worst[0].name, 'ラー油', 'hall: ブラックリストの中身');

var bal = L.computeCategoryBalance(db3);
eq(bal.length, 1, 'balance: 記録のあるカテゴリのみ');
eq(bal[0].counts, { m2: 1, m1: 1, p1: 2, p2: 1 }, 'balance: 分布');
eq(bal[0].n, 5, 'balance: n');

var cl = L.computeClarity(db3.items);
eq(cl.extremeRate, 40, 'clarity: ±2率 = 2/5');
eq(cl.label, 'グラデーション型', 'clarity: ラベル');
eq(cl.asymmetry, null, 'clarity: 両側4件未満は非対称文なし');

// 気変わり: ラーメンを +2 → -2 に(history 2件・差4)
var dbc = L.applyJudgment(db3, { name: 'ラーメン', categoryId: 'c_preset_food', score: -2, nowIso: iso(500), nowMs: T0 + 500000, rand4: 'dddd' }).db;
var ch = L.computeChanges(dbc.items);
eq(ch.length, 1, 'changes: 1件検出');
eq(ch[0].dir, 'down', 'changes: 幻滅方向');
eq(ch[0].first, 2, 'changes: 初回');
eq(ch[0].last, -2, 'changes: 最新');
eq(L.computeChanges(db3.items).length, 0, 'changes: history1件は対象外');

// キーワード: 「担々麺」「冷やしラーメン」等では gram 3件未満 → 空
var kw = L.computeKeywords(db3.items);
eq(kw.top.length + kw.bottom.length, 0, 'keywords: 3アイテム未満の gram は不採用');
// 「味噌」が3アイテムに現れるデータを作る(ひらがなのみ・長音入り gram は除外される)
var dbk = db3;
var kwNames = [['味噌ラーメン', 2], ['味噌汁', 1], ['味噌カツ', 2]];
for (var k2 = 0; k2 < kwNames.length; k2++) {
  dbk = L.applyJudgment(dbk, { name: kwNames[k2][0], categoryId: 'c_preset_food', score: kwNames[k2][1], nowIso: iso(600 + k2), nowMs: T0, rand4: 'k' + k2 + 'zz' }).db;
}
var kw2 = L.computeKeywords(dbk.items);
ok(kw2.top.length > 0, 'keywords: 3アイテム以上で採用');
var hasKanjiGram = kw2.top.some(function (e) { return e.gram === '味噌'; });
ok(hasKanjiGram, 'keywords: 「味噌」を採用 (' + JSON.stringify(kw2.top) + ')');
for (var k3 = 0; k3 < kw2.top.length; k3++) {
  ok(!/^[ぁ-ゖー]+$/.test(kw2.top[k3].gram), 'keywords: ひらがなのみ gram は不採用 (' + kw2.top[k3].gram + ')');
}

var prof = L.computeProfile(dbk, T0 + 700000);
ok(prof.text.indexOf('食べ物') >= 0, 'profile: 最多カテゴリ');
eq(prof.tiles.length, 3, 'profile: タイル3枚');
eq(prof.tiles[0].value, '8', 'profile: 記録件数');

var un = L.computeUnlocks(dbk);
eq(un.cards.length, 7, 'unlocks: カード7枚');
ok(un.cards[0].unlocked, 'unlocks: このみ計は n≥1 で解放');
ok(un.cards[1].unlocked, 'unlocks: 殿堂は n≥5 で解放(n=7)');
ok(!un.cards[2].unlocked, 'unlocks: バランスは n=7 で未解放');
eq(un.unlockedCount, 2, 'unlocks: 解放数');

// ---- charts(構造の煙テスト) ----
ok(C.gaugeSVG(55, 'テスト').indexOf('<svg') === 0, 'charts: gauge が SVG');
ok(C.gaugeSVG(0, 'x').indexOf('gauge-fill') < 0, 'charts: 0% は fill 無し');
ok(C.gaugeSVG(100, 'x').indexOf('gauge-fill') > 0, 'charts: 100% は fill 有り');
ok(C.pipSVG(2).indexOf('sc-p2') > 0, 'charts: pip が該当セルを塗る');
ok(C.divergingRowSVG({ m2: 1, m1: 2, p1: 3, p2: 4 }, 10).indexOf('sc-m2') > 0, 'charts: 発散バー');
ok(C.divergingRowSVG({ m2: 0, m1: 0, p1: 0, p2: 0 }, 10).indexOf('rect') < 0, 'charts: 0件行はバー無し');
ok(C.histogramSVG({ m2: 1, m1: 0, p1: 2, p2: 3 }, ['a', 'b', 'c', 'd']).indexOf('<svg') === 0, 'charts: ヒストグラム');
ok(C.slopeSVG([{ name: '<注入>', first: 2, last: -2, dir: 'down' }], function () { return 'x'; }).indexOf('<注入>') < 0, 'charts: 名前をエスケープ');
ok(C.progressSVG(3, 10).indexOf('cap-fill') > 0, 'charts: 進捗カプセル');
ok(C.meterSVG(0, 'cap-fill').indexOf('cap-fill') < 0, 'charts: 0% メーターは fill 無し');
eq(C.esc('<a>&"\''), '&lt;a&gt;&amp;&quot;&#39;', 'charts: esc');
eq(C.truncate('あいうえおかきくけこ', 5), 'あいうえお…', 'charts: truncate');

// ---- 結果 ----
if (failures > 0) {
  console.log('失敗: ' + failures + '/' + total);
  $.exit(1);
} else {
  console.log('全テスト成功: ' + total + '件');
}
