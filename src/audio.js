import * as Tone from "tone";

// ───────────────────────────────────────────────────────────
// WARM UP TIMER — サウンド設計 (シンプル化版)
//
// モードは 2 種:
//   piano   : 10秒前から jazz swing hihat、0:00 でピアノ Bm9 コード
//   rooster : 10秒前からニワトリ「コココココ…」、0:00 で「コケコッコー!」
//
// 予告は 10 秒前から。1 拍 = 1.25s。8拍ぶん。
// ───────────────────────────────────────────────────────────

export const WARMUP_SECONDS = 10;

// piano: Bm9 ボイシング (root + 3rd + 5th + 7th + 9th + 11th-ish)
export const PIANO_BM9 = ["B2", "B3", "D4", "F#4", "A4", "C#5"];

// 1拍 (1.25s) ごとの jazz swing hihat: 「チーチッチ」
const HIHAT_PER_BEAT = [
  { offset: 0,                       type: "open"   }, // チー
  { offset: 0.625,                   type: "closed" }, // チッ
  { offset: 0.625 + (0.625 * 2 / 3), type: "closed" }, // チ (swung 8th)
];

// 10秒間 (= 8拍) のハイハットスケジュール (sb = 残り秒)
export const HIHAT_SCHEDULE = (() => {
  const arr = [];
  for (let cycleStart = WARMUP_SECONDS; cycleStart > 0.05; cycleStart -= 1.25) {
    HIHAT_PER_BEAT.forEach(({ offset, type }) => {
      const sb = cycleStart - offset;
      if (sb > 0.05) arr.push({ sb, type });
    });
  }
  return arr;
})();

// ニワトリのクラック: cluck.mp3 が 9秒の連続音源なので、
// 警告開始時 (sb = WARMUP_SECONDS) に 1 回だけ start して鳴らし切る。
// → CLUCK_SCHEDULE は不要 (App.jsx 側で単発トリガー)

// フィナーレ用 (現状未使用 — 将来コード分散和音に戻すなら参照)
export const FINISH_STAGGER_MS = 100;

// ───────────────────────────────────────────────────────────
// サンプラ / プレイヤ群
// ───────────────────────────────────────────────────────────

const PIANO_URLS = {
  "A1": "A1.mp3",   "A2": "A2.mp3",   "A3": "A3.mp3",   "A4": "A4.mp3",   "A5": "A5.mp3",
  "C2": "C2.mp3",   "C3": "C3.mp3",   "C4": "C4.mp3",   "C5": "C5.mp3",
  "D#2": "Ds2.mp3", "D#3": "Ds3.mp3", "D#4": "Ds4.mp3", "D#5": "Ds5.mp3",
  "F#2": "Fs2.mp3", "F#3": "Fs3.mp3", "F#4": "Fs4.mp3", "F#5": "Fs5.mp3",
};

export function createInstruments() {
  const reverb = new Tone.Reverb({ decay: 4, wet: 0.22 }).toDestination();

  // ピアノ (Salamander Grand)
  const piano = new Tone.Sampler({
    urls: PIANO_URLS,
    baseUrl: "https://tonejs.github.io/audio/salamander/",
    release: 5,
  }).connect(reverb);

  // ハイハット (NoiseSynth + ハイパス)
  const hihatFilter = new Tone.Filter({ frequency: 8000, type: "highpass", Q: 0.8 }).connect(reverb);
  const hihatClosed = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 },
  }).connect(hihatFilter);
  hihatClosed.volume.value = -22;

  const hihatOpen = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.12 },
  }).connect(hihatFilter);
  hihatOpen.volume.value = -22;

  // ニワトリ音 (public/sounds/ に置いた mp3 を読む)
  // ファイル不在時は onerror で握りつぶす → ロード失敗してもアプリは起動する。
  const cluck = new Tone.Player({
    url: "/sounds/cluck.mp3",
    autostart: false,
    onerror: () => {},
  }).toDestination();
  cluck.volume.value = -2;

  const crow = new Tone.Player({
    url: "/sounds/crow.m4a",
    autostart: false,
    onerror: () => {},
  }).toDestination();
  crow.volume.value = -1;

  return { piano, hihatClosed, hihatOpen, cluck, crow, reverb };
}
