# 復元手順 — 2026-04-28 jazz hihat version

このスナップショットは「ジャズ風ハイハット 3 フェーズ + ピアノ/ギター/サックス」のサウンド設計が完成した時点のもの。

## 内容
- `src/App.jsx` — 状態機械、UI レイアウト (WARM UP TIMER 表示)
- `src/Dial.jsx` — 60本ティック + キッチンタイマー方式 + 虹色チェイス
- `src/audio.js` — PROGRESSIONS 3種, instruments 3種, hihat 3 phase
- `src/index.css` — カラートークン、Barlow Condensed/Inter フォント
- `src/main.jsx`
- `index.html` — DIN Condensed + Barlow Condensed + Inter 読み込み
- `vite.config.js` — LAN 公開設定
- `package.json`

## 復元 (このバージョンに戻す)
プロジェクトルートで以下を実行:

```bash
cp _snapshot/2026-04-28-jazz-hihat-version/src/* src/
cp _snapshot/2026-04-28-jazz-hihat-version/index.html .
cp _snapshot/2026-04-28-jazz-hihat-version/vite.config.js .
```

`package.json` は通常変更しないので、依存関係を変えていなければ不要。

## このバージョンの特徴 (サウンド)
- **コード進行**: Bm9 / Cmaj9#11 / G#6 の3パターンからランダム
- **楽器**: piano / guitar / saxophone の3種からランダム
- **予告メロディ**: 残り15秒から1.25秒間隔で12音 (低オクターブ→通常オクターブのペア)
- **ハイハット 3 フェーズ**:
  - 30→20s: 拍頭 closed のみ「チッ・チッ・チッ・チ」
  - 20→10s: jazz swing「チー・チッ・チ」
  - 10→0s: 偶数拍で stacc を「キ」(tight) に置換
- **フィナーレ (0:00)**: bass + 高音 stagger (100ms)、サックスのみ二人編成 (sustain bass + staccato run + 最後の長音 climax)
- **iOS マナーモード回避**: 隠し audio 要素 + 無音 WAV ループ
