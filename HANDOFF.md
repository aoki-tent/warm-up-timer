# 予告タイマー (introtimer) — 引き継ぎメモ

> 試作の **サウンド設計が確定した時点** での状態。次のフェーズは **UI 検討**。
> 元仕様: `/Users/aokiryousaku/Downloads/files/SPEC.md` (v1) と `SPEC_v2.md` (v2)。

---

## プロジェクト概要

パスタを茹でたり、コーヒーを淹れたりする時に、**0:00 で突然アラームが鳴る前に
最後30秒〜15秒で「もうすぐだよ」と優しく予告してくれる** タイマーアプリ。
予告は耳障りなアラームではなく、**ピアノ/ギター/サックス + ハイハット** で、
ジャズ/ボサノバ風の和音アルペジオが1音ずつ立ち上がっていく。

### スタック
- **Vite + React 18** (テンプレ標準)
- **Tone.js v15** (オーディオ)
- **Tailwind CSS 3** (utility-first スタイル)

### ローカル起動
```bash
cd /Users/aokiryousaku/Library/CloudStorage/Dropbox/cloude作業用/introtimer
npm run dev   # 5173 が他プロジェクトに使われていれば 5175 などにフォールバック
```
依存インストール時は `--cache "$PWD/.npm-cache"` 推奨 (ユーザーのグローバル npm cache に
root 所有のディレクトリが混ざっており EACCES が出たため、プロジェクトローカル cache を使用中)。

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/App.jsx` | メイン: 状態機械、tick ループ、トリガーロジック、UI |
| `src/audio.js` | 音楽データ (PROGRESSIONS, SECONDS_BEFORE, HIHAT_SCHEDULE) と Sampler セットアップ |
| `src/Dial.jsx` | 円形ダイアル (SVG、ドラッグ、アーク描画、中央タップ編集) |
| `src/ChordTimeline.jsx` | **未使用** (v2 でレイアウトから外したが将来用に残置) |
| `src/index.css` | Tailwind directive のみ |
| `index.html` | タイトル `予告タイマー · pre-warning timer` |

---

## サウンド設計 (確定)

### タイミング基本グリッド
- **1拍 = 1.25秒** (ピアノのメロディー間隔)
- **シーケンス全体 = 30秒** (ハイハット start ポイント)
- **ピアノ/ギター/サックス start = 残り15秒**
- **フィナーレ = 0:00**

### コード進行 (3種、`audio.js` の `PROGRESSIONS`、start ごとにランダム)

| ID | mood | 性格 |
|---|---|---|
| `Bm9` | dreamy minor | 切ない・夢見るマイナー |
| `Cmaj9#11` | luminous lydian | 浮遊感のある明るさ |
| `G#6` | bright lift | 明るく開けたメジャー6 |

各コードは **12音の melody** (低オクターブ/通常オクターブのペア × 6コードトーン) と、
2音の **bass** (root + 5th) を持つ。**最後のペアの高音 = シーケンス全体の最高音** が
共通ルール (climax)。例 Bm9: 最後 E3/E5、E5 が最高音。

### 楽器 (3種、`audio.js` の `createInstruments()`、start ごとにランダム)

| 楽器 | サンプル | 特徴 |
|---|---|---|
| **piano** | Salamander Grand (tonejs.github.io) | release 5s、サンプル自然減衰 |
| **guitar** | Acoustic (nbrosowsky/tonejs-instruments) | release 4s、自然減衰 |
| **saxophone** | Saxophone (同上) | release 0.3s、`triggerAttackRelease` で短く articulated |

サックスだけ音を伸ばさず、各音 0.7s で release。**「低音担当と高音担当の二人編成」** イメージ。
低音/高音オクターブをペアで吹くが、各音が次の音より前に途切れる (時間的に重ならない)。

### Countdown スケジュール (`SECONDS_BEFORE`)
残り `[15, 13.75, 12.5, 11.25, 10, 8.75, 7.5, 6.25, 5, 3.75, 2.5, 1.25]` で
melody[0..11] を順に発火。1.25秒グリッドに乗る。

短いタイマーの edge case: `if (sb > durationSec) return` で、開始前に過ぎた発火点だけスキップ。
`sb === durationSec` は開始の瞬間に鳴らす (= 30秒タイマーでも先頭音を取り逃がさない)。

### フィナーレ (0:00)

**Piano / Guitar**:
- t=0: `bass` 全音 + `highMelody[0]` を **同時発音** (`triggerAttack`、自然減衰)
- t=100/200/300/400/500ms: `highMelody[1..5]` を 100ms スタッガー
- 低オクターブ旋律は countdown で既に減衰中なので、フィナーレで **再発音しない**
  (ドンと余分にならず、staccato run の上モノが映える設計)

**Saxophone** (二人編成イメージ):
- t=0: `bass` 全音を **2.0秒 sustain** (`triggerAttackRelease(n, 2.0)`)
- t=0: `highMelody[0]` を 0.12s staccato
- t=100ms..400ms: `highMelody[1..4]` を 0.12s staccato run
- t=500ms: `highMelody[5]` (climax) を **1.6秒 sustain**
- 低音と最後の高音がほぼ同時に release され、余韻に溶ける

### ハイハット (`HIHAT_SCHEDULE`)
**「チーチッチ」のジャズ swing** を 1.25秒サイクルで繰り返し:

| サイクル内位置 | offset | 型 | 説明 |
|---|---|---|---|
| 先頭 | 0s | open「チー」 | 長め decay 0.28s、ピアノの拍と一致 |
| 半拍 | 0.625s | closed「チッ」 | 短い decay 0.05s、表のウラ |
| swung 8th | 1.042s | closed「チ」 | 短い decay、半拍 × 2/3 |

30秒前 → 0:00 直前まで 24サイクル × 3 hit = **72 hit**。NoiseSynth + ハイパス 8kHz で合成。
0:00 のフィナーレで自動停止 (tick が `remaining<=0` で先に return するため)。

---

## 状態機械

```
idle ──[start]──> running ──[time over]──> finished
  ^                  │  ^                     │
  │              [pause] │                    │
  │                  ▼  │                     │
  │               paused─┘                    │
  │                                           │
  └────────[reset / set new]──────────────────┘
```

### State (App.jsx)
- `phase`: `"idle" | "running" | "paused" | "finished"`
- `durationSec`: ユーザーが設定した秒数 (default: localStorage の `lastSetting` または 300)
- `elapsedSec`: 経過時間 (秒、小数あり)
- `progression`, `instrument`: start 時に抽選される楽曲構成
- `audioReady`, `loadStatus`: サンプルロード状態
- `noteHeat`: 視覚的な余韻 0..1 (現状 UI に未表示だが計算継続)
- `instrumentMode`: `"auto" | "piano" | "guitar" | "saxophone"` (試作デバッグ用)

### Tick ループ (Date.now ベース、pause 対応)
- `tickStartRef`: session 開始時刻
- `pausedAtRef`: pause した時刻
- `pausedAccumRef`: 累積 pause 時間
- `requestAnimationFrame` で毎フレーム呼ぶ
- `triggeredRef` (Set) で各イベント (`m_${idx}`, `hh_${idx}`, `__finish__`) の重複発火を防ぐ

### 永続化
- `localStorage["preWarningTimer.history"]`: number[] (最新3件、秒)
- `localStorage["preWarningTimer.lastSetting"]`: number (最後に使用した秒数)
- start 押下時に履歴を更新 (`updateHistory` で重複除去 → 先頭挿入 → 3件まで)

---

## UI 現状 (今ここ)

### 実装済み
- **円形ダイアル** (320px、SVG): ベースリング、5分刻みティック12個、ハンドル (idle のみ)、
  プログレスアーク (running/paused は残り時間で縮む)、12時位置のドット
- **中央表示**: `0:35.42` 形式 (running/paused は cs まで、idle/finished は m:ss のみ)
  + 走行中は `Bm9 · saxophone` のような小ラベル
- **中央タップ → 数値入力モード** (mm:ss テキスト入力、Enter 確定 / Esc キャンセル / blur 確定)
- **履歴ボタン3つ** (idle のみ表示、デフォルト 3:00 / 9:00 / 5:30)
- **メインボタン**: idle=`▶ start`、running=`⏸ pause` + `↺ reset`、paused=`▶ resume` + `↺ reset`、
  finished=`▶ play again` + `set new`
- **ステータス行**: ロード中 / ready (piano · guitar · saxophone) / partial 表示
- **試作デバッグ**: 楽器指定ボタン (auto / piano / guitar / sax)

### スタイル
- 背景: `radial-gradient(ellipse at 50% 0%, #2a201a 0%, #15100c 60%, #0c0907 100%)` (深い暗茶)
- アクセント: `#e5b25c` (ゴールド)、`#f5d584` (ブライトゴールド) for finished
- テキスト: `#f0e6d2` (クリーム) / `#a8927a` / `#7a6852` / `#5a4a38`
- ボーダー: `#3a2e22`
- フォント: **Fraunces** (見出し、italic 多用) + **JetBrains Mono** (数字、ラベル)
- グレインオーバーレイ: SVG turbulence noise、opacity 0.06、mix-blend overlay
- pulseGlow アニメーション (1.3s) — 現状 NoteMarker 用に書いてあるが未使用

### 未実装/UI 検討で扱う候補
- [ ] **状態遷移のクロスフェード** (300-400ms ease-out) — 今は瞬時切り替え
- [ ] **楽器指定ボタンの本番化または撤去** (今は試作デバッグ色のまま)
- [ ] **モバイル最適化** (Pointer Events は OK、ダイアルサイズの可変化、タッチ快適性)
- [ ] **履歴ボタンのデザイン仕上げ** (空のときの扱い、重複時のフィードバック)
- [ ] **paused 時の中央数字点滅** (CSS keyframes `dialPulse` は定義済、適用される設計)
- [ ] **finished 時の文字 + アーク残光** (textShadow は設定済、もう少し演出余地あり)
- [ ] **音量調整 UI** (現状サンプル volume 固定: piano 0dB / guitar -3dB / sax -8dB / hihat -22dB)
- [ ] **ダークモード切り替えなど環境対応** (今は dark 一択)
- [ ] **ロード中の見せ方** (progress 表示など、現状はテキストのみ)
- [ ] **PWA化、Web Push、バックグラウンド動作** (Web Workers / Audio Worklet 検討)

---

## ハマりどころ・既知の制約

- **Tone.start() はユーザー操作必須**: start ボタン onClick 内で `await Tone.start()`。
- **`Tone.loaded()` は全 Sampler のロード完了を待つ**: 失敗時のために 15秒 timeout フォールバック
  (`loadStatus = "partial"`) を実装済み。partial 時は loaded な楽器に自動フォールバック。
- **Sax 低音域**: nbrosowsky の sax サンプル最低が C#3。B1 / D2 / G#1 などは
  C#3 から大きく pitch-shift されてラフな質感になる。今のところ「あえての低音吐息感」として OK。
- **Guitar URL リスト**: GitHub API で実在する mp3 のみを `audio.js` に列挙してある (リポに無いファイル名を入れると Tone.loaded() がハングする)。
- **コードトーンの命名**: Tone は `#` 表記、ファイルは `s` 表記 (`F#3` ↔ `Fs3.mp3`)。マッピングは `audio.js` の `*_URLS` で完結。
- **`HIHAT_SCHEDULE` の最後**: 0:00 直前 (sb=0.208s) の swung 8th まで鳴る。フィナーレ前で打ち切る `if (sb > 0.05)` フィルタあり。
- **Sax フィナーレの 2.0s sustain**: 高音 climax の 1.6s sustain と概ね同時に release されるよう設計。
- **`ChordTimeline.jsx` は未使用**: import 削除済。将来「タイムライン表示モード」を入れる場合の素材として残置。

---

## 次セッション開始時の最低限の文脈

1. **このメモ** (`HANDOFF.md`) を最初に読む
2. **元仕様**: `/Users/aokiryousaku/Downloads/files/SPEC.md` と `SPEC_v2.md`
3. **コード**: `src/App.jsx` (メイン) → `src/audio.js` (音楽) → `src/Dial.jsx` (UI 部品)
4. **dev**: `npm run dev` で localhost:5175 (or 5173/5174 が空いていればそちら)

サウンドはユーザー OK 出済。**次は UI 検討フェーズ**。

### ユーザーの好み (これまでに見えてきた傾向)
- ミニマル、静謐、ジャズバー的トーン (派手な装飾は嫌う)
- タイムライン表示は不要、ダイアル一枚絵で running もこなす
- 楽器ごとの個性 (sax は単音楽器らしさ、二人編成感) を大事にする
- 鳴っている音そのものへのこだわりが強い (オクターブ位置、音価、リズム感)
- iterative — 1ステップずつ確認しながら進める
