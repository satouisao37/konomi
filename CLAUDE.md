# このみ (konomi)

自分の好き嫌い(「好きな食べ物」「好きな表情」など任意カテゴリ)を素早く記録し、蓄積から人物分析する iPhone 向け PWA。
詳細仕様は末尾の `@import`(spec.md)で読み込む。リポジトリ: `satouisao37/konomi`(**public** — GitHub Pages 配信のための例外)。

> Issue 作成 → 実装 → 日本語コミット → close の**共通フロー・コミット規約・禁止事項は親 `/Users/soshi/dev/CLAUDE.md`「全ツール共通の作業フロー」に集約**。ここには再掲せず、**このツール固有の前提とコマンドだけ**を書く。

## 最重要の前提(壊さないこと)

- **資産参照は相対パスのみ**(Pages サブパス `/konomi/` 配信。`href="/..."` 等の先頭 `/` は禁止)。
- **sw.js を変更したら `CACHE_VERSION` を bump**し、画面のバージョン表記も同時に上げる。
- `js/logic.js` は純粋関数のみ(DOM・fetch・localStorage 禁止)。JXA テストの対象なので ES modules も使わない(plain script + `globalThis.KonomiLogic`)。
- **localStorage スキーマ変更時は `schema_version` を上げ、旧データからのマイグレーションを書く**(ユーザーの好き嫌い記録を消さない)。
- **外部 API・課金 API・LLM 呼び出しは導入しない**(人物分析は完全ローカル計算)。
- ユーザーデータ(好き嫌い記録)はリポジトリに含めない(public リポなので特に厳守)。

## 作業フロー(ツール固有)

- ロジックは **まず `js/logic.js`** に純粋関数として実装し、`test/test_logic.js` にテストを追加する。副作用(DOM・localStorage・SW 登録)は `js/app.js` に閉じ込める。
- コードは素の JS(ビルド無し・依存ゼロ)、コメント・UI 文言は**日本語**。
- デザインは keiki フォーマット厳守: `/Users/soshi/dev/vault/Tools/knowhow/design-formats/keiki.md`(色は必ずトークンの hex 値。確認: `grep -c '#A84600' style.css` 等の機械照合)。
- 実装後に必ず実行する構文チェック＋テスト(正確なコマンド):

  ```bash
  bash test/run.sh   # JXA: 全 .js の new Function 構文チェック + logic.js ユニットテスト(node 不使用)
  python3 -c "import ast; ast.parse(open('tools/gen_icons.py',encoding='utf-8').read())"
  ```

- 動作確認: `python3 -m http.server 8771 -d .` → `http://localhost:8771/`。停止はポート特定 `lsof -ti tcp:8771 | xargs kill`。ヘッドレス確認は headless Chrome + CDP(共通ノウハウ [[2026-07-04_07-36_headlessChromeはCDPで回収]]・[[2026-07-29_01-30_nodeなしCDP駆動はstdlib自作WS]])。

## Obsidian Vault 連携

### 仕様ノート(必読)
@/Users/soshi/dev/vault/Tools/konomi/spec.md

### ツール固有ノウハウフォルダ
過去のノウハウを参照したくなったら `Glob`/`Read`:
- `/Users/soshi/dev/vault/Tools/konomi/knowhow/`

(共通ノウハウ・ユーザー好み・キャプチャルール・作業フローは親 `/Users/soshi/dev/CLAUDE.md` で読み込み済み)
