# 通知に異常なし

**▶ 遊ぶ：https://katomi95.github.io/tsuuchi-ni-ijou-nashi/**

スマートフォンの通知センターに届く通知の中から、「よく考えるとおかしい通知」だけをタップするゲーム。1プレイ約4分（12:56〜13:00）。

素の HTML / CSS / JavaScript のみ。外部通信なし。`index.html` を GitHub Pages などで配信すれば遊べます。

## ファイル

- `js/notifications.js` … 通知データ・アプリ定義・特殊通知・エンディング・ゲーム設定（CONFIG）
- `js/game.js` … 進行・判定・スコア・結果画面・エンディング
- `css/style.css` … 見た目

## 通知の追加

`js/notifications.js` に1行足すだけです。

```js
A('hakobi', 2, '本文', '解説');          // 異常（難易度1〜3）
N('hakobi', '本文');                     // 正常
Q('hakobi', '本文', '誤タップ時の解説');  // 変わっているけど正常
N('msg', '本文', 'お母さん');            // 差出人つき
```

出現割合・速度・スコアは `CONFIG` で調整できます。

## 検証用パラメータ

- `?autostart` … すぐ開始
- `?seed=数字` … 出現順を固定
- `?ts=数字` … 時間の倍率
- コンソールの `__game.advance(秒)` で時間を進められます（ブラウザが非表示でも動く）
