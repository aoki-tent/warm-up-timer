import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Dial } from "./Dial.jsx";
import {
  WARMUP_SECONDS,
  PIANO_BM9,
  HIHAT_SCHEDULE,
  createInstruments,
} from "./audio.js";

const MODE_KEY = "warmupTimer.mode"; // "piano" | "rooster"

// ───────────────────────────────────────────────────────────
// 定数
// ───────────────────────────────────────────────────────────
const MIN_DURATION = 10;       // 10秒
const MAX_DURATION = 3600;     // 60分
const SNAP_SEC = 1;            // 1秒刻みで設定可
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
function loadMode() {
  const raw = localStorage.getItem(MODE_KEY);
  return raw === "rooster" ? "rooster" : "piano";
}

export default function App() {
  const [phase, setPhase] = useState("idle");
  const [durationSec, setDurationSec] = useState(loadLast);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [history, setHistory] = useState(loadHistory);
  const [mode, setMode] = useState(loadMode);                // "piano" | "rooster"
  const [showInfo, setShowInfo] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [loadStatus, setLoadStatus] = useState("loading");
  const [, forceTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const pianoRef = useRef(null);
  const hihatClosedRef = useRef(null);
  const hihatOpenRef = useRef(null);
  const cluckRef = useRef(null);
  const crowRef = useRef(null);
  const reverbRef = useRef(null);
  const tickStartRef = useRef(null);
  const pausedAtRef = useRef(null);
  const pausedAccumRef = useRef(0);
  const triggeredRef = useRef(new Set());
  const tickRafRef = useRef(null);
  const editInputRef = useRef(null);
  // rAF ループのクロージャがstaleにならないように mode は ref 経由で読む
  const modeRef = useRef(mode);

  // ── オーディオ初期化 ──────────────────────────────
  useEffect(() => {
    const { piano, hihatClosed, hihatOpen, cluck, crow, reverb } = createInstruments();
    pianoRef.current = piano;
    hihatClosedRef.current = hihatClosed;
    hihatOpenRef.current = hihatOpen;
    cluckRef.current = cluck;
    crowRef.current = crow;
    reverbRef.current = reverb;

    let timedOut = false;
    let resolved = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (resolved) return;
      // ピアノが読めていれば piano モードは動く。rooster は cluck/crow が無いと無音。
      if (piano.loaded) {
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
      hihatClosed.dispose();
      hihatOpen.dispose();
      cluck.dispose();
      crow.dispose();
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

  // ── フィナーレ (0:00 で 1 回鳴る音) ────────────────
  const fireFinale = useCallback(() => {
    if (modeRef.current === "rooster") {
      // ROOSTER: コケコッコー!
      const crow = crowRef.current;
      if (crow && crow.loaded) {
        try { crow.stop(); } catch {}
        crow.start();
      }
    } else {
      // PIANO: Bm9 をアルペジオで下から上へ立ち上げる (90ms スタッガー)
      const piano = pianoRef.current;
      if (piano && piano.loaded) {
        PIANO_BM9.forEach((n, i) => {
          setTimeout(() => piano.triggerAttack(n), i * 90);
        });
      }
    }
  }, []);

  // ── tick ─ mode は ref から読む ────────────────────
  const tick = useCallback(() => {
    const now = Date.now();
    const elapsed = (now - tickStartRef.current - pausedAccumRef.current) / 1000;
    const remaining = durationSec - elapsed;

    if (remaining <= 0) {
      setElapsedSec(durationSec);
      setPhase("finished");
      if (!triggeredRef.current.has("__finish__")) {
        triggeredRef.current.add("__finish__");
        fireFinale();
      }
      return;
    }

    setElapsedSec(elapsed);
    forceTick((n) => n + 1);

    const m = modeRef.current;

    if (m === "rooster") {
      // ROOSTER: 警告開始時 (10秒前) に cluck を 1 回だけ start。
      // ファイルが 9秒の連続音源なのでループ・再トリガーは不要。
      const sb = WARMUP_SECONDS;
      if (sb <= durationSec && remaining <= sb && !triggeredRef.current.has("cl_once")) {
        triggeredRef.current.add("cl_once");
        const cluck = cluckRef.current;
        if (cluck && cluck.loaded) {
          try { cluck.stop(); } catch {}
          cluck.start();
        }
      }
    } else {
      // PIANO: jazz swing hihat
      HIHAT_SCHEDULE.forEach(({ sb, type }, idx) => {
        if (sb > durationSec) return;
        const key = `hh_${idx}`;
        if (remaining <= sb && !triggeredRef.current.has(key)) {
          triggeredRef.current.add(key);
          const synth = type === "open" ? hihatOpenRef.current : hihatClosedRef.current;
          const dur   = type === "open" ? 0.18 : 0.04;
          synth?.triggerAttackRelease(dur);
        }
      });
    }

    tickRafRef.current = requestAnimationFrame(tick);
  }, [durationSec, fireFinale]);

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
      localStorage.setItem(MODE_KEY, mode);
    } catch {}

    // 同期的に mode を ref に反映 (rAF ループに正しく届けるため)
    modeRef.current = mode;

    triggeredRef.current = new Set();
    setElapsedSec(0);
    setPhase("running");
    tickStartRef.current = Date.now();
    pausedAccumRef.current = 0;
    pausedAtRef.current = null;
    cancelAnimationFrame(tickRafRef.current);
    tickRafRef.current = requestAnimationFrame(tick);
  }, [durationSec, history, mode, tick]);

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
    try { cluckRef.current?.stop(); } catch {}
    try { crowRef.current?.stop(); } catch {}
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

  // モードトグル (ROOSTER | PIANO)
  const handleModeChange = (next) => {
    if (phase !== "idle") return;
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch {}
  };

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
          space-between で上下を画面の端に貼り付ける。
          INFO 表示中は上をヘッダーのみ + 説明文 (flex:1) に切り替え。 */}
      <div style={{
        maxWidth: 420,
        margin: "0 auto",
        height: "100%",
        padding: "12px 14px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: showInfo ? "flex-start" : "space-between",
        minHeight: 0,
      }}>
        {/* 上ブロック: 横線で区切られたヘッダー */}
        <div style={{
          borderTop: "2px solid var(--border)",
          borderBottom: "2px solid var(--border)",
          flex: "0 0 auto",
        }}>
          {/* WARM UP TIMER (タップで INFO 表示切替) */}
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            style={{
              display: "block",
              width: "100%",
              background: "transparent",
              border: "none",
              borderBottom: showInfo ? "none" : "2px solid var(--border)",
              padding: "14px 4px",
              cursor: "pointer",
              outline: "none",
              fontFamily: "inherit",
            }}
          >
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
          </button>

          {/* sub-row: ROOSTER | PIANO トグル (INFO中は非表示) */}
          {!showInfo && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              position: "relative",
              padding: "10px 0",
            }}>
              <ModeToggleCell
                label="ROOSTER"
                active={mode === "rooster"}
                onClick={() => handleModeChange("rooster")}
                disabled={phase !== "idle"}
              />
              <ModeToggleCell
                label="PIANO"
                active={mode === "piano"}
                onClick={() => handleModeChange("piano")}
                disabled={phase !== "idle"}
              />
              {/* 短い縦線 (上下の横線に届かない高さ) */}
              <div style={{
                position: "absolute",
                left: "50%",
                top: "30%",
                bottom: "30%",
                width: 2,
                background: "var(--border)",
                transform: "translateX(-50%)",
                pointerEvents: "none",
              }} />
            </div>
          )}
        </div>

        {showInfo ? (
          <InfoBody />
        ) : (
          /* 下ブロック: Buttons + History */
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
        )}
      </div>

      {/* ダイアル — viewport の正中央に絶対配置 (INFO中は非表示) */}
      {!showInfo && (
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
      )}
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
// 説明 (タイトルタップで開く)
// ───────────────────────────────────────────────────────────
function InfoBody() {
  const linkStyle = {
    color: "var(--ink)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  };
  return (
    <div className="font-akkurat" style={{
      flex: "1 1 auto",
      minHeight: 0,
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
      padding: "20px 6px 24px",
      fontSize: 15,
      lineHeight: 1.75,
      color: "var(--ink)",
      letterSpacing: "0.01em",
    }}>
      <p style={{ marginTop: 0 }}>
        パスタを作る。フレンチプレスでコーヒーを作る。毎日の暮らしの中でタイマーは頻繁に使ってるんだけど「予告なしにいきなり鳴る」のがなんか嫌だ。
      </p>
      <p>
        そんな気持ちから生まれたのが、この『WARM UP TIMER（ウォームアップタイマー）』です。
      </p>
      <p>
        10秒前からさりげない音が鳴り始めるので、事前準備ができます。ROOSTER（ニワトリ）とPIANO（ピアノ）の２種類から音が選べます。
      </p>
      <p>過去３回分の時間が下から選べます。</p>
      <p>まだ試作なので、ウィンドウを閉じると、音は鳴りません。ご注意ください。</p>

      <hr style={{
        margin: "22px 0",
        border: 0,
        borderTop: "1px solid var(--ink-dim)",
      }} />

      <p>・このアプリは、TENTの青木が作りました。</p>
      <p>
        ・TENTの他のプロジェクト<br />
        TENTのTEMPO（リンク：{" "}
        <a href="https://tempo.tent1000.com/" target="_blank" rel="noopener noreferrer" style={linkStyle}>
          https://tempo.tent1000.com/
        </a>
        ）
      </p>
      <p>
        ・お問い合わせ・感想<br />
        <a href="https://x.com/aoki_TENT" target="_blank" rel="noopener noreferrer" style={linkStyle}>
          @aoki_tent
        </a>
        （リンク：{" "}
        <a href="https://x.com/aoki_TENT" target="_blank" rel="noopener noreferrer" style={linkStyle}>
          https://x.com/aoki_TENT
        </a>
        ）
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// モードトグル (ROOSTER | PIANO)
// active = ブラック、inactive = グレーアウト
// ───────────────────────────────────────────────────────────
function ModeToggleCell({ label, active, onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled && !active}
      className="font-medium-stack"
      style={{
        background: "transparent",
        border: "none",
        padding: "8px 14px",
        textAlign: "center",
        fontFamily: "inherit",
        fontWeight: active ? 700 : 500,
        fontSize: 19,
        letterSpacing: "0.08em",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        cursor: disabled ? "default" : "pointer",
        outline: "none",
      }}
    >
      {label}
    </button>
  );
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
