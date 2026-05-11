import * as Tone from "tone";
import { Mp3Encoder } from "@breezystack/lamejs";

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

// テール長 (秒): WARMUP_SECONDS + 余韻
//   ROOSTER: crow が ~2.5 秒、念のため余裕を持って 4 秒余韻 → 14 秒
//   PIANO  : 90ms × 6 のアタック後、release 5 秒のサステイン → 14 秒
export const TAIL_TOTAL_SECONDS = WARMUP_SECONDS + 4;

// ───────────────────────────────────────────────────────────
// オフラインレンダリング用の音源パス
// ───────────────────────────────────────────────────────────
const PIANO_URLS = {
  "A1": "A1.mp3",   "A2": "A2.mp3",   "A3": "A3.mp3",   "A4": "A4.mp3",   "A5": "A5.mp3",
  "C2": "C2.mp3",   "C3": "C3.mp3",   "C4": "C4.mp3",   "C5": "C5.mp3",
  "D#2": "Ds2.mp3", "D#3": "Ds3.mp3", "D#4": "Ds4.mp3", "D#5": "Ds5.mp3",
  "F#2": "Fs2.mp3", "F#3": "Fs3.mp3", "F#4": "Fs4.mp3", "F#5": "Fs5.mp3",
};
const PIANO_BASE_URL = "https://tonejs.github.io/audio/salamander/";
const CLUCK_URL = "/sounds/cluck.mp3";
const CROW_URL = "/sounds/crow.m4a";

// ───────────────────────────────────────────────────────────
// オフライン合成: モードごとの「警告 + 本鳴り」テールを 1 本の AudioBuffer に焼く
// ───────────────────────────────────────────────────────────

/**
 * Tone.Offline でテールバッファを 1 回だけ作る。
 * t=0 が「警告開始」、t=WARMUP_SECONDS が「本鳴り」のタイミング。
 *
 * @param {"piano" | "rooster"} mode
 * @returns {Promise<AudioBuffer>}
 */
export async function renderTailBuffer(mode) {
  const buf = await Tone.Offline(async () => {
    const reverb = new Tone.Reverb({ decay: 4, wet: 0.22 }).toDestination();

    if (mode === "rooster") {
      const cluck = new Tone.Player({ url: CLUCK_URL, autostart: false }).toDestination();
      cluck.volume.value = -2;
      const crow = new Tone.Player({ url: CROW_URL, autostart: false }).toDestination();
      crow.volume.value = -1;

      // テール座標系の t=0 は「警告開始」。Tone.Offline 内では絶対時間で予約する。
      await Tone.loaded();
      cluck.start(0);
      crow.start(WARMUP_SECONDS);
    } else {
      const piano = new Tone.Sampler({
        urls: PIANO_URLS,
        baseUrl: PIANO_BASE_URL,
        release: 5,
      }).connect(reverb);

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

      await Tone.loaded();

      // ハイハット: HIHAT_SCHEDULE の sb (= 残り秒) → t = WARMUP_SECONDS - sb
      HIHAT_SCHEDULE.forEach(({ sb, type }) => {
        const t = WARMUP_SECONDS - sb;
        if (t < 0) return;
        const synth = type === "open" ? hihatOpen : hihatClosed;
        const dur   = type === "open" ? 0.18 : 0.04;
        synth.triggerAttackRelease(dur, t);
      });

      // 本鳴り: Bm9 をアルペジオ (90ms スタッガー)
      PIANO_BM9.forEach((n, i) => {
        piano.triggerAttack(n, WARMUP_SECONDS + (i * 0.09));
      });
    }
  }, TAIL_TOTAL_SECONDS);

  // Tone.Offline は ToneAudioBuffer を返す。生 AudioBuffer に剥がす
  return buf.get();
}

// ───────────────────────────────────────────────────────────
// AudioBuffer → MP3 (Blob) 合成
//   ・先頭に silenceSeconds 秒の無音を挿入
//   ・続けて tailBuffer の中身を流す
// 無音区間は実体としてゼロ Int16Array をチャンク投入する。
// ───────────────────────────────────────────────────────────

// MP3 フレーム単位 = 1152 サンプル。
// エンコーダ呼び出しコストを下げるため、サンプル投入は 1 秒 (≒ 38 frames) 単位でまとめる。
const FRAMES_PER_CHUNK = 38;

/**
 * @param {AudioBuffer} tailBuffer  Tone.Offline でレンダリングしたテール
 * @param {number} silenceSeconds   テール開始までの無音秒数
 * @param {object} [opts]
 * @param {number} [opts.kbps=64]   モノラル時のビットレート
 * @returns {Promise<Blob>}         audio/mpeg の Blob
 */
export async function bakeTimerMp3(tailBuffer, silenceSeconds, opts = {}) {
  const kbps = opts.kbps ?? 64;
  const sampleRate = tailBuffer.sampleRate;
  const encoder = new Mp3Encoder(1, sampleRate, kbps);

  // テールはモノラルにまとめる
  const tailMono = mixToMono(tailBuffer);
  const tailI16 = floatToInt16(tailMono);

  const chunkSamples = 1152 * FRAMES_PER_CHUNK;
  const silentBigChunk = new Int16Array(chunkSamples); // 全 0
  const silenceSamples = Math.max(0, Math.round(silenceSeconds * sampleRate));
  const fullChunks = Math.floor(silenceSamples / chunkSamples);
  const silenceRemainder = silenceSamples - fullChunks * chunkSamples;

  const mp3Chunks = [];

  // 無音区間 (大きい単位でまとめて投入)
  for (let i = 0; i < fullChunks; i++) {
    const out = encoder.encodeBuffer(silentBigChunk);
    if (out.length > 0) mp3Chunks.push(out);
    // UI を完全に止めないように、たまに yield
    if ((i & 0x0f) === 0x0f) await yieldToBrowser();
  }
  if (silenceRemainder > 0) {
    const out = encoder.encodeBuffer(silentBigChunk.subarray(0, silenceRemainder));
    if (out.length > 0) mp3Chunks.push(out);
  }

  // テール (全部まとめて投入)
  const tailOut = encoder.encodeBuffer(tailI16);
  if (tailOut.length > 0) mp3Chunks.push(tailOut);

  const tail = encoder.flush();
  if (tail.length > 0) mp3Chunks.push(tail);

  return new Blob(mp3Chunks, { type: "audio/mpeg" });
}

function mixToMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  if (ch === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= ch;
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
