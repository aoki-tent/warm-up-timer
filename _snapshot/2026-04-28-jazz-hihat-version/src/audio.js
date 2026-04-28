import * as Tone from "tone";

// ── コード進行: 6パターンから start ごとにランダム選択 ─────────
// 旋律パターン (各コード共通):
//   コードトーン 6 種 (root / 3rd / 5th / 7th / 9th / 11 or 13) について
//   「2オクターブ下 → 通常オクターブ」の2音をペアで鳴らす。 計 12 音。
//   旋律配列の偶数 index = 低オクターブ、奇数 index = 通常オクターブ。
//
//   試作: 15秒前から 1.25s 間隔で 12音
//   15s    : root  (-2 oct)    10s   : 5th  (-2 oct)    5s    : 9th (-2 oct)
//   13.75s : root              8.75s : 5th              3.75s : 9th
//   12.5s  : 3rd   (-2 oct)    7.5s  : 7th  (-2 oct)    2.5s  : 11/13 (-2 oct)
//   11.25s : 3rd               6.25s : 7th              1.25s : 11/13
//
//   0:00: bass (root + 5th) を t=0 で土台に、通常オクターブ旋律 6 音だけを
//         100ms スタッガーで重ねる。低オクターブ側は countdown で既に
//         鳴って減衰中なので再発音せず、自然な余韻として土台に溶ける。
export const PROGRESSIONS = [
  // 切ない・夢見るマイナー
  { id: "Bm9",       mood: "dreamy minor",
    melody: ["B1","B3", "D2","D4", "F#2","F#4", "A2","A4", "C#3","C#5", "E3","E5"],
    bass:   ["B1","F#2"] },
  // 浮遊感のある明るさ (Lydian)
  { id: "Cmaj9#11",  mood: "luminous lydian",
    melody: ["C1","C3", "E1","E3", "G1","G3", "B1","B3", "D2","D4", "F#2","F#4"],
    bass:   ["C2","G2"] },
  // 明るく開けた響き (G# major 6 = Ab6)
  // tones: G#(root) / C(3) / D#(5) / F(6) … 最後に C と D# をオクターブ上げて climax
  { id: "G#6",       mood: "bright lift",
    melody: ["G#1","G#3", "C2","C4", "D#2","D#4", "F2","F4", "C3","C5", "D#3","D#5"],
    bass:   ["G#1","D#2"] },
];

// 残り何秒で旋律の何番目をトリガーするか
// (15秒前スタート、1.25s 間隔の12点)
export const SECONDS_BEFORE = [15, 13.75, 12.5, 11.25, 10, 8.75, 7.5, 6.25, 5, 3.75, 2.5, 1.25];

// ハイハット: 3 フェーズ進行で密度を上げていく。
//   30→20s "チッチッチッチ"          : 拍頭の closed 1発のみ (シンプル)
//   20→10s "チーチッチ × 2"          : 既存 jazz swing (open + closed-stacc + closed)
//   10→0s  "チーチッチ + チーチキチ" : 偶数サイクルで stacc を「キ」(tight) に置換
// 1 サイクル = 1.25s (= ピアノの 1 拍)。30秒前スタート、フィナーレ直前まで。
export const HIHAT_SCHEDULE = (() => {
  const arr = [];
  const cycleLen = 1.25;
  const halfBeat = cycleLen / 2;            // 0.625
  const swingOffset = halfBeat * (2 / 3);   // ≈ 0.417 (swung 8th)

  let cycleIdx = 0;
  for (let cycleStart = 30; cycleStart > 0.05; cycleStart -= cycleLen) {
    let offsets;
    if (cycleStart > 20.0001) {
      // Phase 1: 拍頭 closed のみ
      offsets = [{ offset: 0, type: "closed" }];
    } else if (cycleStart > 10.0001) {
      // Phase 2: 既存 jazz swing
      offsets = [
        { offset: 0,                       type: "open"   }, // チー
        { offset: halfBeat,                type: "closed" }, // チッ
        { offset: halfBeat + swingOffset,  type: "closed" }, // チ
      ];
    } else {
      // Phase 3: 偶数サイクルで closed-stacc を "tight" (キ) に
      const useTight = (cycleIdx % 2 === 1);
      offsets = [
        { offset: 0,                       type: "open"   },
        { offset: halfBeat,                type: useTight ? "tight" : "closed" },
        { offset: halfBeat + swingOffset,  type: "closed" },
      ];
    }

    offsets.forEach(({ offset, type }) => {
      const sb = cycleStart - offset;
      if (sb > 0.05) arr.push({ sb, type });
    });

    cycleIdx++;
  }
  return arr;
})();

// フィナーレで高音1音ずつをずらして鳴らすときの間隔 (ms)
export const FINISH_STAGGER_MS = 100;

// Salamander Grand Piano (Tone.js 公式)
const PIANO_URLS = {
  "A1": "A1.mp3",   "A2": "A2.mp3",   "A3": "A3.mp3",   "A4": "A4.mp3",   "A5": "A5.mp3",
  "C2": "C2.mp3",   "C3": "C3.mp3",   "C4": "C4.mp3",   "C5": "C5.mp3",
  "D#2": "Ds2.mp3", "D#3": "Ds3.mp3", "D#4": "Ds4.mp3", "D#5": "Ds5.mp3",
  "F#2": "Fs2.mp3", "F#3": "Fs3.mp3", "F#4": "Fs4.mp3", "F#5": "Fs5.mp3",
};

// Acoustic Guitar (nbrosowsky/tonejs-instruments) — リポジトリに存在する mp3 のみ採用
// "s" → "#" のマッピング (Tone は `#` 表記、ファイルは `s` 表記)
const GUITAR_URLS = {
  "A2":  "A2.mp3",  "A3":  "A3.mp3",  "A4":  "A4.mp3",
  "A#2": "As2.mp3", "A#3": "As3.mp3", "A#4": "As4.mp3",
  "B2":  "B2.mp3",  "B3":  "B3.mp3",  "B4":  "B4.mp3",
  "C3":  "C3.mp3",  "C4":  "C4.mp3",  "C5":  "C5.mp3",
  "C#3": "Cs3.mp3", "C#4": "Cs4.mp3", "C#5": "Cs5.mp3",
  "D2":  "D2.mp3",  "D3":  "D3.mp3",  "D4":  "D4.mp3",  "D5": "D5.mp3",
  "D#2": "Ds2.mp3", "D#3": "Ds3.mp3", "D#4": "Ds4.mp3",
  "E2":  "E2.mp3",  "E3":  "E3.mp3",  "E4":  "E4.mp3",
  "F2":  "F2.mp3",  "F3":  "F3.mp3",  "F4":  "F4.mp3",
  "F#2": "Fs2.mp3", "F#3": "Fs3.mp3", "F#4": "Fs4.mp3",
  "G2":  "G2.mp3",  "G3":  "G3.mp3",  "G4":  "G4.mp3",
  "G#2": "Gs2.mp3", "G#3": "Gs3.mp3",
};

// Saxophone (nbrosowsky/tonejs-instruments) — C#3〜G#5 まで半音刻みで存在。
// B1〜C3 の低音域はサンプル無く pitch-shift で代用 (粒は荒くなるが鳴る)。
const SAX_URLS = {
  "C#3": "Cs3.mp3", "D3": "D3.mp3",  "D#3": "Ds3.mp3", "E3": "E3.mp3",
  "F3":  "F3.mp3",  "F#3": "Fs3.mp3","G3":  "G3.mp3",  "G#3": "Gs3.mp3",
  "A#3": "As3.mp3", "B3":  "B3.mp3", "C4":  "C4.mp3",  "C#4": "Cs4.mp3",
  "D4":  "D4.mp3",  "D#4": "Ds4.mp3","E4":  "E4.mp3",  "F4":  "F4.mp3",
  "F#4": "Fs4.mp3", "G4":  "G4.mp3", "G#4": "Gs4.mp3", "A4":  "A4.mp3",
  "A#4": "As4.mp3", "B4":  "B4.mp3", "C5":  "C5.mp3",  "C#5": "Cs5.mp3",
  "D5":  "D5.mp3",  "D#5": "Ds5.mp3","E5":  "E5.mp3",  "F5":  "F5.mp3",
  "F#5": "Fs5.mp3", "G5":  "G5.mp3", "G#5": "Gs5.mp3", "A5":  "A5.mp3",
};

// 両サンプラーをまとめてセットアップ。共通のリバーブを通してテイルを伸ばす。
export function createInstruments() {
  const reverb = new Tone.Reverb({ decay: 7, wet: 0.32 }).toDestination();

  const piano = new Tone.Sampler({
    urls: PIANO_URLS,
    baseUrl: "https://tonejs.github.io/audio/salamander/",
    release: 5,
  }).connect(reverb);

  const guitar = new Tone.Sampler({
    urls: GUITAR_URLS,
    baseUrl: "https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-acoustic/",
    release: 4,
  }).connect(reverb);
  guitar.volume.value = -3;

  // サックスは「一人で吹いてる感」を出すため release を短めに (息継ぎっぽく)。
  const sax = new Tone.Sampler({
    urls: SAX_URLS,
    baseUrl: "https://nbrosowsky.github.io/tonejs-instruments/samples/saxophone/",
    release: 0.3,
  }).connect(reverb);
  sax.volume.value = -8;

  // ハイハット: ハイパス済みホワイトノイズの envelope で「チ」を作る。
  // closed (短い decay) と open (長め decay) の 2 種を用意して swing pattern を吹き分け。
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

  // tight (キ): closed よりさらに短く、明るめのフィルタを通す。アクセントになるよう volume も持ち上げる。
  const hihatTightFilter = new Tone.Filter({ frequency: 9500, type: "highpass", Q: 0.9 }).connect(reverb);
  const hihatTight = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.025 },
  }).connect(hihatTightFilter);
  hihatTight.volume.value = -12; // 他のhihat (-22) よりはっきり目立つように

  return { piano, guitar, sax, hihatClosed, hihatOpen, hihatTight, reverb };
}
