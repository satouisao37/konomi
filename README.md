# このみ (konomi)

自分の好き嫌い(「好きな食べ物」「好きな表情」など任意カテゴリ)を数タップで記録し、蓄積から人物分析する iPhone 向け PWA。

- 配信: https://satouisao37.github.io/konomi/
- データは端末の localStorage のみに保存(このリポジトリに個人データは含まれない)
- 依存ゼロ(vanilla JS・ビルド無し)・オフライン動作(Service Worker)

## 使い方

1. iPhone の Safari で上記 URL を開く
2. 共有メニュー →「ホーム画面に追加」
3. 以後はアイコンから起動して好き嫌いを登録

## 開発

```bash
python3 -m http.server 8771 -d .   # http://localhost:8771/
bash test/run.sh                   # 構文チェック + ユニットテスト(JXA、node 不使用)
```
