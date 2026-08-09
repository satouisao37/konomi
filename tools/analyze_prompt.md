# このみの人物分析

以下に渡される JSON は、好き嫌いを記録する PWA「このみ」のエクスポートです。記録に基づき、利用者の好みの構造を分析してください。

## データの読み方

- エクスポートは通常、`app: "konomi"`、`kind: "backup"`、`schema_version`、`exported_at`、`counts`、`checksum` と、本体である `data` を持つエンベロープです。本体の DB を直接書き出した形式の場合もあります。
- 本体には `app: "konomi"`、`schema_version`、`categories`、`items`、`settings` があります。分析では主に `categories` と `items` を使ってください。
- `categories` の各要素は `id`、`name`、`emoji`、`preset`、`sort`、`createdAt` を持ちます。`items` の各要素は `id`、`categoryId`、`name`、表示用ではない照合キー `norm`、任意メモ `note`、`history`、`createdAt`、`updatedAt` を持ちます。
- `history` の各要素は、判定時刻 `at` とスコア `score` を持ちます。スコアは 0 を使わない4段階です: `-2` = 🤢 大嫌い、`-1` = 😕 苦手、`1` = 🙂 好き、`2` = 😍 大好き。
- 同じ `norm` の品目を再判定すると新しい品目は作られず、既存品目の `history` 末尾に判定が追加されます。履歴が20件を超えると、最初の1件と最新19件だけを残します。これは変化の始点を残すためです。
- エクスポート時には `settings.lastBackupAt` と `settings.dirtySinceBackup` がリセットされます。これらは人物分析の根拠にしないでください。

## 出力ルール

- データに無い事実を作らない。
- 根拠は品目名と件数で示す。
- 件数が少ない領域は断定しない。
- 出力はレポート本文の Markdown のみとし、前置き・後書き・全体のコードフェンス囲みを付けない。
- 日本語で書く。

## 総評

## カテゴリ別の好みの構造

## 一貫した軸・価値観の仮説

## 意外な組み合わせ・矛盾

## 時系列の変化

## データの偏りと次に記録すると良いもの
