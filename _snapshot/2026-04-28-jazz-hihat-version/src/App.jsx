import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Dial } from "./Dial.jsx";
import {
  PROGRESSIONS,
  SECONDS_BEFORE,
  HIHAT_SCHEDULE,
  FINISH_STAGGER_MS,
  createInstruments,
} from "./audio.js";

// ───────────────────────────────────────────────────────────
// 定数
// ───────────────────────────────────────────────────────────
const MIN_DURATION = 30;       // 30秒
const MAX_DURATION = 3600;     // 60分
const SNAP_SEC = 30;
const HISTORY_KEY = "preWarningTimer.history";
const LAST_KEY = "preWarningTimer.lastSetting";
const DEFAULT_HISTORY = [30, 180, 540];   // 0:30 / 3:00 / 9:00
const DEFAULT_LAST = 300;                  // 5:00
const SAMPLE_LOAD_TIMEOUT_MS = 15000;

// ───────────────────────────────────────────────────────────
// 永続化ヘルパ
// ───────────────────────────────────────────────────────────
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [...DEFAULT_HISTORY];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every((n) => Number.isFinite(n))) return arr.slice(0, 3);
  } catch {}
  return [...DEFAULT_HISTORY];
}
function loadLast() {
  const raw = parseInt(localStorage.getItem(LAST_KEY) ?? "", 10);
  if (Number.isFinite(raw) && raw >= MIN_DURATION && raw <= MAX_DURATION) return raw;
  return DEFAULT_LAST;
}
function updateHistory(currentSec, history) {
  const filtered = history.filter((t) => t !== currentSec);
  return [currentSec, ...filtered].slice(0, 3);
}

// ───────────────────────────────────────────────────────────
// 表示用フォーマット
// ───────────────────────────────────────────────────────────
function fmtMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const r = (s % 60).toString().padStart(2, "0");
  return `${m}:${r}`;
}
function parseMmSs(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // コロン入りは "m:ss" 形式
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length !== 2) return null;
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (!Number.isFinite(m) || !Number.isFinite(s) || s < 0 || s >= 60 || m < 0) return null;
    return m * 60 + s;
  }

  // 数字だけ → 右2桁=秒、それより左=分 として解釈
  // 例: "5000" → 50:00、"300" → 3:00、"30" → 0:30、"130" → 1:30
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num) || num < 0) return null;
  const sec = num % 100;
  const min = Math.floor(num / 100);
  // 秒部が 60 以上のときは繰り上げて扱う
  return min * 60 + sec;
}

// ───────────────────────────────────────────────────────────
// メイン
// ───────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState("idle");
  const [durationSec, setDurationSec] = useState(loadLast);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [history, setHistory] = useState(loadHistory);
  const [progression, setProgression] = useState(PROGRESSIONS[0]);
  const [instrument, setInstrument] = useState("piano");
  const [audioReady, setAudioReady] = useState(false);
  const [loadStatus, setLoadStatus] = useState("loading");
  const [, forceTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const pianoRef = useRef(null);
  const guitarRef = useRef(null);
  const saxRef = useRef(null);
  const hihatClosedRef = useRef(null);
  const hihatOpenRef = useRef(null);
  const hihatTightRef = useRef(null);
  const reverbRef = useRef(null);
  const tickStartRef = useRef(null);
  const pausedAtRef = useRef(null);
  const pausedAccumRef = useRef(0);
  const triggeredRef = useRef(new Set());
  const tickRafRef = useRef(null);
  const editInputRef = useRef(null);
  // tick の rAF ループは古いクロージャを掴んだまま回るので、
  // 「いま鳴らすべき楽器・コード」は ref 経由で同期する。
  const instrumentRef = useRef("piano");
  const progressionRef = useRef(PROGRESSIONS[0]);

  // ── オーディオ初期化 ──────────────────────────────
  useEffect(() => {
    const { piano, guitar, sax, hihatClosed, hihatOpen, hihatTight, reverb } = createInstruments();
    pianoRef.current = piano;
    guitarRef.current = guitar;
    saxRef.current = sax;
    hihatClosedRef.current = hihatClosed;
    hihatOpenRef.current = hihatOpen;
    hihatTightRef.current = hihatTight;
    reverbRef.current = reverb;

    let timedOut = false;
    let resolved = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (resolved) return;
      const pianoOk = piano.loaded;
      const guitarOk = guitar.loaded;
      if (pianoOk || guitarOk) {
        setLoadStatus("partial");
        setAudioReady(true);
      } else {
        setLoadStatus("loading");
      }
    }, SAMPLE_LOAD_TIMEOUT_MS);

    Tone.loaded().then(() => {
      resolved = true;
      if (timedOut) return;
      clearTimeout(timer);
      setLoadStatus("ready");
      setAudioReady(true);
    });

    return () => {
      clearTimeout(timer);
      piano.dispose();
      guitar.dispose();
      sax.dispose();
      hihatClosed.dispose();
      hihatOpen.dispose();
      hihatTight.dispose();
      reverb.dispose();
      cancelAnimationFrame(tickRafRef.current);
    };
  }, []);

  // ── 編集モード突入時にフォーカス ────────────────────
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  // ── ヘルパ: 現在の楽器のサンプラ (ref から読む) ────
  const getSamplerNow = useCallback(() => {
    const inst = instrumentRef.current;
    if (inst === "guitar") return guitarRef.current;
    if (inst === "saxophone") return saxRef.current;
    return pianoRef.current;
  }, []);

  // ── ノート発火 (ref から現在の楽器を読む) ──────────
  const triggerNote = useCallback((note) => {
    const inst = instrumentRef.current;
    const s = getSamplerNow();
    if (s && s.loaded) {
      if (inst === "saxophone") {
        s.triggerAttackRelease(note, 0.7);
      } else {
        s.triggerAttack(note);
      }
    }
  }, [getSamplerNow]);

  const fireFinale = useCallback((prog) => {
    const inst = instrumentRef.current;
    const s = getSamplerNow();
    if (!s || !s.loaded) return;

    const highMelody = prog.melody.filter((_, i) => i % 2 === 1);

    if (inst === "saxophone") {
      prog.bass.forEach((n) => {
        s.triggerAttackRelease(n, 2.0);
      });
      if (highMelody.length > 0) {
        s.triggerAttackRelease(highMelody[0], 0.12);
      }
      const lastIdxInSlice = highMelody.length - 2;
      highMelody.slice(1).forEach((n, i) => {
        const isLast = i === lastIdxInSlice;
        setTimeout(() => {
          s.triggerAttackRelease(n, isLast ? 1.6 : 0.12);
        }, (i + 1) * FINISH_STAGGER_MS);
      });
      return;
    }

    const t0Notes = new Set([
      ...prog.bass,
      ...(highMelody.length > 0 ? [highMelody[0]] : []),
    ]);
    t0Notes.forEach((n) => s.triggerAttack(n));
    highMelody.slice(1).forEach((n, i) => {
      setTimeout(() => s.triggerAttack(n), (i + 1) * FINISH_STAGGER_MS);
    });
  }, [getSamplerNow]);

  // ── tick ─ progression / instrument は ref から読む ──
  const tick = useCallback(() => {
    const now = Date.now();
    const elapsed = (now - tickStartRef.current - pausedAccumRef.current) / 1000;
    const remaining = durationSec - elapsed;
    const prog = progressionRef.current;

    if (remaining <= 0) {
      setElapsedSec(durationSec);
      setPhase("finished");
      if (!triggeredRef.current.has("__finish__")) {
        triggeredRef.current.add("__finish__");
        fireFinale(prog);
      }
      return;
    }

    setElapsedSec(elapsed);
    forceTick((n) => n + 1);

    SECONDS_BEFORE.forEach((sb, idx) => {
      if (sb > durationSec) return;
      const key = `m_${idx}`;
      if (remaining <= sb && !triggeredRef.current.has(key)) {
        triggeredRef.current.add(key);
        triggerNote(prog.melody[idx]);
      }
    });

    HIHAT_SCHEDULE.forEach(({ sb, type }, idx) => {
      if (sb > durationSec) return;
      const key = `hh_${idx}`;
      if (remaining <= sb && !triggeredRef.current.has(key)) {
        triggeredRef.current.add(key);
        let synth, dur;
        if (type === "open") {
          synth = hihatOpenRef.current;
          dur = 0.18;
        } else if (type === "tight") {
          synth = hihatTightRef.current;
          dur = 0.02;
        } else {
          synth = hihatClosedRef.current;
          dur = 0.04;
        }
        synth?.triggerAttackRelease(dur);
      }
    });

    tickRafRef.current = requestAnimationFrame(tick);
  }, [durationSec, fireFinale, triggerNote]);

  // ── ボタンアクション ─────────────────────────────
  const handleStart = useCallback(async () => {
    await Tone.start();
    // iOS マナーモード回避: 隠し audio 要素を再生して
    // オーディオセッションを Ambient → Playback に昇格させる
    const silent = document.getElementById("ios-mute-bypass");
    if (silent && silent.paused) {
      silent.play().catch(() => {});
    }

    const newHist = updateHistory(durationSec, history);
    setHistory(newHist);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(newHist));
      localStorage.setItem(LAST_KEY, String(durationSec));
    } catch {}

    const prog = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    const instCandidates = ["piano", "guitar", "saxophone"];
    const refByName = {
      piano: pianoRef,
      guitar: guitarRef,
      saxophone: saxRef,
    };
    let inst = instCandidates[Math.floor(Math.random() * instCandidates.length)];
    if (!refByName[inst].current?.loaded) {
      const loaded = instCandidates.find((k) => refByName[k].current?.loaded);
      if (loaded) inst = loaded;
    }
    // ref を同期的に更新 (rAF ループのクロージャと表示を一致させるため)
    progressionRef.current = prog;
    instrumentRef.current = inst;
    setProgression(prog);
    setInstrument(inst);

    triggeredRef.current = new Set();
    setElapsedSec(0);
    setPhase("running");
    tickStartRef.current = Date.now();
    pausedAccumRef.current = 0;
    pausedAtRef.current = null;
    cancelAnimationFrame(tickRafRef.current);
    tickRafRef.current = requestAnimationFrame(tick);
  }, [durationSec, history, tick]);

  const handlePause = useCallback(() => {
    if (phase !== "running") return;
    pausedAtRef.current = Date.now();
    cancelAnimationFrame(tickRafRef.current);
    setPhase("paused");
  }, [phase]);

  const handleResume = useCallback(() => {
    if (phase !== "paused") return;
    pausedAccumRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = null;
    setPhase("running");
    tickRafRef.current = requestAnimationFrame(tick);
  }, [phase, tick]);

  const handleReset = useCallback(() => {
    cancelAnimationFrame(tickRafRef.current);
    if (pianoRef.current) pianoRef.current.releaseAll();
    if (guitarRef.current) guitarRef.current.releaseAll();
    triggeredRef.current = new Set();
    setElapsedSec(0);
    pausedAtRef.current = null;
    pausedAccumRef.current = 0;
    setPhase("idle");
  }, []);

  // ── finished から 5 秒で idle に自動復帰 ────────────
  useEffect(() => {
    if (phase !== "finished") return;
    const t = setTimeout(() => handleReset(), 5000);
    return () => clearTimeout(t);
  }, [phase, handleReset]);

  // ── 数値入力モード ─────────────────────────────
  const beginEdit = () => {
    setEditValue(fmtMMSS(durationSec));
    setEditing(true);
  };
  const commitEdit = () => {
    const parsed = parseMmSs(editValue);
    if (parsed != null) {
      const clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, parsed));
      const snapped = Math.round(clamped / SNAP_SEC) * SNAP_SEC;
      setDurationSec(Math.max(MIN_DURATION, Math.min(MAX_DURATION, snapped)));
    }
    setEditing(false);
  };
  const cancelEdit = () => setEditing(false);

  const handleHistoryClick = (sec) => {
    if (phase !== "idle") return;
    const clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, sec));
    setDurationSec(Math.round(clamped / SNAP_SEC) * SNAP_SEC);
  };

  // ── 表示計算 ────────────────────────────────────
  const remainingSec =
    phase === "running" || phase === "paused"
      ? Math.max(0, durationSec - elapsedSec)
      : phase === "finished"
        ? 0
        : durationSec;

  const centerSec =
    phase === "running" || phase === "paused" ? remainingSec
    : phase === "finished"                    ? 0
    :                                            durationSec;

  // ── ボタンの状態別ラベル/ハンドラ ──────────────
  const primary =
    phase === "idle"     ? { label: "START",   on: handleStart,    disabled: !audioReady }
  : phase === "running"  ? { label: "PAUSE",   on: handlePause,    disabled: false }
  : phase === "paused"   ? { label: "RESUME",  on: handleResume,   disabled: false }
  :                        { label: "START",   on: handleStart,    disabled: !audioReady };

  const secondary =
    phase === "idle"     ? { label: "RESET", on: () => {},        disabled: true }
  : phase === "finished" ? { label: "NEW",   on: handleReset,     disabled: false }
  :                        { label: "RESET", on: handleReset,     disabled: false };

  // INSTRUMENT/CHORD 表示
  const showMeta = phase !== "idle";
  const instrumentLabel = showMeta ? instrument.toUpperCase() : "INSTRUMENT";
  const chordLabel      = showMeta ? progression.id.toUpperCase() : "CHORD";

  return (
    <div style={{
      height: "100dvh",
      overflow: "hidden",
      background: "var(--bg)",
      position: "relative",
      boxSizing: "border-box",
    }}>
      {/* iOS マナーモード回避: 無音ループを再生して audio session を Playback 扱いに */}
      <audio
        id="ios-mute-bypass"
        loop
        playsInline
        preload="auto"
        src="data:audio/wav;base64,UklGRkAAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YR4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        style={{ display: "none" }}
      />
      {/* 上下にピン留めされた帯 (header+sub / buttons+history)。
          space-between で上下を画面の端に貼り付ける。 */}
      <div style={{
        maxWidth: 420,
        margin: "0 auto",
        height: "100%",
        padding: "12px 14px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}>
        {/* 上ブロック: 横線3本 + 短い縦線で区切る (左右の枠線なし) */}
        <div style={{
          borderTop: "2px solid var(--border)",
          borderBottom: "2px solid var(--border)",
        }}>
          {/* WARM UP TIMER (中段の横線で区切る) */}
          <div style={{
            padding: "14px 4px",
            borderBottom: "2px solid var(--border)",
          }}>
            <h1 style={{
              margin: 0,
              textAlign: "center",
              fontWeight: 800,
              fontSize: "clamp(38px, 10.8vw, 53px)",
              letterSpacing: "0.02em",
              color: "var(--ink)",
              lineHeight: 1,
              paddingTop: "0.20em",
            }}>
              WARM UP TIMER
            </h1>
          </div>

          {/* sub-row: INSTRUMENT | CHORD (中央に短い縦線) */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            position: "relative",
            padding: "12px 0",
          }}>
            <div className="font-medium-stack" style={subCellPlain()}>{instrumentLabel}</div>
            <div className="font-medium-stack" style={subCellPlain()}>{chordLabel}</div>
            {/* 短い縦線 (上下の横線に届かない高さ) */}
            <div style={{
              position: "absolute",
              left: "50%",
              top: "30%",
              bottom: "30%",
              width: 2,
              background: "var(--border)",
              transform: "translateX(-50%)",
            }} />
          </div>
        </div>

        {/* 下ブロック: Buttons + History */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* ボタン群 */}
          <div style={{
            ...boxStyle(),
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
          }}>
            <ActionButton {...primary} borderRight />
            <ActionButton {...secondary} />
          </div>

          {/* 履歴 */}
          <div style={{
            ...boxStyle(),
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
          }}>
            {(history.length ? history : DEFAULT_HISTORY).slice(0, 3).map((sec, i) => (
              <HistoryCell
                key={`${sec}_${i}`}
                sec={sec}
                active={phase === "idle" && durationSec === sec}
                disabled={phase !== "idle"}
                borderRight={i < 2}
                onClick={() => handleHistoryClick(sec)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ダイアル — viewport の正中央に絶対配置 (白丸の中心 = 画面中央) */}
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "min(calc(100vw - 28px), 420px, calc(100dvh - 380px))",
        aspectRatio: "1 / 1",
      }}>
        <Dial
          phase={phase}
          durationSec={durationSec}
          remainingSec={remainingSec}
          pulseCenter={phase === "paused"}
          onTapCenter={beginEdit}
          centerNode={
            <CenterTime
              sec={centerSec}
              editing={editing}
              editValue={editValue}
              onEditChange={setEditValue}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              editRef={editInputRef}
            />
          }
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// ボックスのデフォルトスタイル
// ───────────────────────────────────────────────────────────
function boxStyle(extra = {}) {
  return {
    border: "2px solid var(--border)",
    background: "transparent",
    ...extra,
  };
}

function subCell({ borderRight = false } = {}) {
  return {
    padding: "12px 14px",
    textAlign: "center",
    fontWeight: 500,
    fontSize: 19,
    letterSpacing: "0.08em",
    color: "var(--ink)",
    borderRight: borderRight ? "2px solid var(--border)" : "none",
  };
}

function subCellPlain() {
  return {
    padding: "0 14px",
    textAlign: "center",
    fontWeight: 500,
    fontSize: 19,
    letterSpacing: "0.08em",
    color: "var(--ink)",
  };
}

// ───────────────────────────────────────────────────────────
// 中央時間表示 + 編集フィールド
// ───────────────────────────────────────────────────────────
function CenterTime({ sec, editing, editValue, onEditChange, onCommit, onCancel, editRef }) {
  if (editing) {
    return (
      <input
        ref={editRef}
        type="text"
        inputMode="numeric"
        value={editValue}
        onChange={(e) => onEditChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="mm:ss"
        style={{
          background: "transparent",
          border: "1.5px solid var(--ink)",
          color: "var(--ink)",
          fontFamily: "inherit",
          fontWeight: 800,
          fontSize: 67,
          width: 200,
          textAlign: "center",
          letterSpacing: "0.02em",
          outline: "none",
          padding: "4px 8px",
        }}
      />
    );
  }

  // m / s に分割してコロンを別 span で持ち、上下中央へずらす
  const ss = Math.max(0, Math.floor(sec));
  const mm = Math.floor(ss / 60).toString().padStart(2, "0");
  const rr = (ss % 60).toString().padStart(2, "0");
  return (
    <div style={{
      fontWeight: 800,
      fontSize: 77,
      lineHeight: 1,
      color: "var(--ink)",
      letterSpacing: "0.01em",
      fontVariantNumeric: "tabular-nums",
      // DIN Condensed Bold は ascender が高く descender がほぼ無いため、
      // flex center だと数字が光学的に上寄りになる。少しだけ下に押し下げる。
      paddingTop: "0.10em",
      display: "inline-flex",
      alignItems: "center",
    }}>
      <span>{mm}</span>
      <span style={{
        // DIN Condensed Bold のコロンは数字の縦中央より下にあるため、上に持ち上げる
        display: "inline-block",
        transform: "translateY(-0.20em)",
        margin: "0 0.02em",
      }}>:</span>
      <span>{rr}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// アクションボタン (START / PAUSE / RESUME / REPLAY / RESET / NEW)
// ───────────────────────────────────────────────────────────
function ActionButton({ label, on, disabled, borderRight = false }) {
  return (
    <button
      onClick={disabled ? undefined : on}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "none",
        borderRight: borderRight ? "2px solid var(--border)" : "none",
        padding: "22px 14px 16px",
        fontFamily: "inherit",
        fontWeight: 800,
        fontSize: 34,
        lineHeight: 1,
        letterSpacing: "0.04em",
        color: disabled ? "var(--ink-dim)" : "var(--ink)",
        cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "center",
        outline: "none",
      }}
    >
      {label}
    </button>
  );
}

// ───────────────────────────────────────────────────────────
// 履歴セル
// ───────────────────────────────────────────────────────────
function HistoryCell({ sec, active, disabled, borderRight, onClick }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        background: active ? "var(--ink)" : "transparent",
        color: active ? "var(--surface)" : disabled ? "var(--ink-dim)" : "var(--ink)",
        border: "none",
        borderRight: borderRight ? "2px solid var(--border)" : "none",
        padding: "15px 10px 11px",
        fontFamily: "inherit",
        fontWeight: 700,
        fontSize: 22,
        lineHeight: 1,
        letterSpacing: "0.04em",
        cursor: disabled ? "not-allowed" : "pointer",
        outline: "none",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {fmtMMSS(sec)}
    </button>
  );
}
