import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Dial } from "./Dial.jsx";
import {
  WARMUP_SECONDS,
  TAIL_TOTAL_SECONDS,
  renderTailBuffer,
  bakeTimerMp3,
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

// vite.config.js で define される (`dev YYYY-MM-DD HH:mm` または `<sha> · YYYY-MM-DD HH:mm`)
// eslint-disable-next-line no-undef
const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "unknown";

// 初期 src として使う極短い無音 WAV (dataURI)。
// iOS Safari は audio.play() がユーザージェスチャ内で「何かしらの src 上で」一度呼ばれることを
// 要求するので、ブランクではなくこの dataURI を常時セットしておく (リセット時にも戻す)。
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRkAAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YR4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
  const [remainingSec, setRemainingSec] = useState(loadLast);
  const [history, setHistory] = useState(loadHistory);
  const [mode, setMode] = useState(loadMode);                // "piano" | "rooster"
  const [showInfo, setShowInfo] = useState(false);
  const [tailsReady, setTailsReady] = useState(false);
  const [loadStatus, setLoadStatus] = useState("loading");   // "loading" | "ready" | "error"
  const [preparing, setPreparing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  // 事前合成テール (mode → AudioBuffer)
  const tailBufferRef = useRef({ piano: null, rooster: null });

  // <audio> 要素と Blob URL
  const audioElRef = useRef(null);
  const blobUrlRef = useRef(null);

  // 表示更新用 rAF
  const displayRafRef = useRef(null);
  const editInputRef = useRef(null);

  // ── 初期ロード: テールを事前合成 ──────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Tone は内部で AudioContext を作るが、Tone.Offline は OfflineAudioContext を使うので
        // ユーザージェスチャは不要。リモートのピアノサンプル読み込みも内部で済む。
        const [piano, rooster] = await Promise.all([
          renderTailBuffer("piano"),
          renderTailBuffer("rooster"),
        ]);
        if (cancelled) return;
        tailBufferRef.current = { piano, rooster };
        setTailsReady(true);
        setLoadStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("[warmup-timer] failed to render tail buffers:", err);
        setLoadStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(displayRafRef.current);
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // ── 編集モード突入時にフォーカス ────────────────────
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  // ── 表示更新ループ (audio.currentTime ベース) ─────
  // <audio> がバックグラウンドでも独立して再生され続けるので、表示はそれに追従するだけ。
  // タブ復帰時のズレも自動で正される。
  const tickDisplay = useCallback(() => {
    const el = audioElRef.current;
    if (!el) return;
    const cur = el.currentTime;
    const totalAudio = durationSec + (TAIL_TOTAL_SECONDS - WARMUP_SECONDS);
    // 残り時間 = 「設定時間 - 現在再生位置」だが、本鳴り(0:00) は durationSec - WARMUP_SECONDS の地点に来る
    //   → audio.currentTime が durationSec - WARMUP_SECONDS = (durationSec - 10) のとき、本鳴り開始 = 残り 0
    // ただし表示は countdown 視点で「残り durationSec から始まり 0 で終わる」を維持したい
    // つまり: 残り表示 = durationSec - audio.currentTime - WARMUP_SECONDS と思いきや、
    // 違う: 設計を見直す。
    //
    // 仕様:
    //   audio.currentTime = 0         → タイマー残り durationSec (開始直後)
    //   audio.currentTime = durationSec - WARMUP → 残り WARMUP_SECONDS (警告開始 = 残り 10 秒)
    //   audio.currentTime = durationSec        → 残り 0 (本鳴り)
    //   audio.currentTime > durationSec        → 余韻フェーズ
    //
    // よって: 残り表示 = max(0, durationSec - audio.currentTime)
    const remaining = Math.max(0, durationSec - cur);
    setRemainingSec(remaining);

    if (el.ended || cur >= totalAudio - 0.01) {
      setPhase("finished");
      return;
    }
    displayRafRef.current = requestAnimationFrame(tickDisplay);
  }, [durationSec]);

  // ── テールを所定オフセットで合成して <audio> をセットアップ ──
  const prepareAudio = useCallback(async () => {
    const tail = tailBufferRef.current[mode];
    if (!tail) throw new Error("tail buffer not ready");

    // 「警告開始 = 残り WARMUP_SECONDS」になるので、テール開始までの無音 = durationSec - WARMUP_SECONDS
    const silenceSec = Math.max(0, durationSec - WARMUP_SECONDS);
    const blob = await bakeTimerMp3(tail, silenceSec, { kbps: 64 });

    // 前回の Blob URL があれば解放
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    const el = audioElRef.current;
    if (!el) throw new Error("audio element missing");
    el.src = url;
    el.load();

    // メタデータ読み込みを待つ (currentTime を 0 に確実にするため)
    await new Promise((resolve) => {
      const ok = () => { el.removeEventListener("loadedmetadata", ok); resolve(); };
      el.addEventListener("loadedmetadata", ok, { once: true });
      // 既に読み込み済みなら即解決
      if (el.readyState >= 1) ok();
    });
  }, [mode, durationSec]);

  // ── ボタンアクション ─────────────────────────────
  const handleStart = useCallback(async () => {
    if (!tailsReady || preparing) return;
    setPreparing(true);
    try {
      // iOS Safari: ユーザージェスチャ内で一度 audio.play() を呼んでおくと、
      // 以後の src 差し替え + play() が許可される。
      const el = audioElRef.current;
      if (el) {
        try { el.muted = true; await el.play(); el.pause(); el.muted = false; } catch {}
      }

      // "WAIT…" 表示を React に確実に描画させてからエンコードに入る
      await new Promise((r) => requestAnimationFrame(() => r()));

      await prepareAudio();

      const newHist = updateHistory(durationSec, history);
      setHistory(newHist);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(newHist));
        localStorage.setItem(LAST_KEY, String(durationSec));
        localStorage.setItem(MODE_KEY, mode);
      } catch {}

      setRemainingSec(durationSec);
      setPhase("running");

      if (el) {
        el.currentTime = 0;
        await el.play();
      }
      cancelAnimationFrame(displayRafRef.current);
      displayRafRef.current = requestAnimationFrame(tickDisplay);
    } catch (err) {
      console.error("[warmup-timer] start failed:", err);
      setPhase("idle");
    } finally {
      setPreparing(false);
    }
  }, [tailsReady, preparing, prepareAudio, durationSec, history, mode, tickDisplay]);

  const handlePause = useCallback(() => {
    if (phase !== "running") return;
    const el = audioElRef.current;
    if (el) el.pause();
    cancelAnimationFrame(displayRafRef.current);
    setPhase("paused");
  }, [phase]);

  const handleResume = useCallback(() => {
    if (phase !== "paused") return;
    const el = audioElRef.current;
    if (el) el.play().catch(() => {});
    setPhase("running");
    displayRafRef.current = requestAnimationFrame(tickDisplay);
  }, [phase, tickDisplay]);

  const handleReset = useCallback(() => {
    cancelAnimationFrame(displayRafRef.current);
    const el = audioElRef.current;
    if (el) {
      el.pause();
      // 無音 dataURI に戻して、次回 START 時のユーザージェスチャ play() が成功するようにしておく
      el.src = SILENT_WAV_DATA_URI;
      el.load();
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setRemainingSec(durationSec);
    setPhase("idle");
  }, [durationSec]);

  // ── finished から 5 秒で idle に自動復帰 ────────────
  useEffect(() => {
    if (phase !== "finished") return;
    const t = setTimeout(() => handleReset(), 5000);
    return () => clearTimeout(t);
  }, [phase, handleReset]);

  // ── Screen Wake Lock: 実行中は画面スリープを抑止 ────
  useEffect(() => {
    if (phase !== "running") return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let lock = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const newLock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          newLock.release().catch(() => {});
          return;
        }
        lock = newLock;
      } catch {
        // 取得失敗 (権限なし等): 静かに諦める
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        acquire();
      }
    };

    acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (lock) lock.release().catch(() => {});
      lock = null;
    };
  }, [phase]);

  // ── タブ復帰時に表示を即同期 ────────────────────────
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && phase === "running") {
        // rAF を再起動して即座に audio.currentTime に合わせる
        cancelAnimationFrame(displayRafRef.current);
        displayRafRef.current = requestAnimationFrame(tickDisplay);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase, tickDisplay]);

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
      const next = Math.max(MIN_DURATION, Math.min(MAX_DURATION, snapped));
      setDurationSec(next);
      setRemainingSec(next);
    }
    setEditing(false);
  };
  const cancelEdit = () => setEditing(false);

  const handleHistoryClick = (sec) => {
    if (phase !== "idle") return;
    const clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, sec));
    const next = Math.round(clamped / SNAP_SEC) * SNAP_SEC;
    setDurationSec(next);
    setRemainingSec(next);
  };

  // ── 表示計算 ────────────────────────────────────
  const centerSec =
    phase === "running" || phase === "paused" ? remainingSec
    : phase === "finished"                    ? 0
    :                                            durationSec;

  // ── ボタンの状態別ラベル/ハンドラ ──────────────
  const startDisabled = !tailsReady || preparing || loadStatus === "error";
  const startLabel = preparing ? "WAIT…" : "START";

  const primary =
    phase === "idle"     ? { label: startLabel, on: handleStart,  disabled: startDisabled }
  : phase === "running"  ? { label: "PAUSE",    on: handlePause,  disabled: false }
  : phase === "paused"   ? { label: "RESUME",   on: handleResume, disabled: false }
  :                        { label: startLabel, on: handleStart,  disabled: startDisabled };

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
      {/* バックグラウンド再生対応: タイマー音は事前合成 MP3 を 1 本の <audio> で流す。
          初期 src は無音 WAV (dataURI) — iOS が要求するユーザージェスチャ内 play() を担保する。 */}
      <audio
        ref={audioElRef}
        playsInline
        preload="auto"
        src={SILENT_WAV_DATA_URI}
        style={{ display: "none" }}
      />
      <div style={{
        maxWidth: 420,
        margin: "0 auto",
        height: "100%",
        paddingTop:    "calc(12px + env(safe-area-inset-top))",
        paddingRight:  "calc(14px + env(safe-area-inset-right))",
        paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
        paddingLeft:   "calc(14px + env(safe-area-inset-left))",
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
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            style={{
              display: "block",
              width: "100%",
              background: "transparent",
              border: "none",
              borderBottom: showInfo ? "none" : "2px solid var(--border)",
              padding: "10px 4px",
              cursor: "pointer",
              outline: "none",
              fontFamily: "inherit",
            }}
          >
            <h1 style={{
              margin: 0,
              textAlign: "center",
              fontWeight: 800,
              fontSize: "clamp(46px, 13vw, 64px)",
              letterSpacing: "0.02em",
              color: "var(--ink)",
              lineHeight: 1,
              paddingTop: "0.28em",
              paddingBottom: "0.04em",
            }}>
              WARM UP TIMER
            </h1>
          </button>

          {!showInfo && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              position: "relative",
              padding: 0,
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
          <InfoBody version={BUILD_VERSION} />
        ) : (
          <>
            <div style={{
              width: "min(100%, 420px, calc(100dvh - 380px - env(safe-area-inset-top) - env(safe-area-inset-bottom)))",
              margin: "0 auto",
              aspectRatio: "1 / 1",
              flex: "0 0 auto",
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

            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "0 0 auto" }}>
              <div style={{
                ...boxStyle(),
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
              }}>
                <ActionButton {...primary} borderRight />
                <ActionButton {...secondary} />
              </div>

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
          </>
        )}
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

// ───────────────────────────────────────────────────────────
// 説明 (タイトルタップで開く)
// ───────────────────────────────────────────────────────────
function InfoBody({ version }) {
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
      <p style={{ marginTop: 0, marginBottom: "1.8em" }}>
        パスタを作る。フレンチプレスでコーヒーを作る。毎日の暮らしの中でタイマーは頻繁に使ってるんだけど「予告なしにいきなり鳴る」のがなんか嫌だ。
      </p>
      <p>
        そんな気持ちから生まれたのが、この『WARM UP TIMER（ウォームアップタイマー）』です。
      </p>
      <p>
        10秒前からさりげない音が鳴り始めるので、事前準備ができます。ROOSTER（ニワトリ）とPIANO（ピアノ）の２種類から音が選べます。
      </p>
      <p style={{ marginBottom: "1.8em" }}>
        過去３回分の時間が下から選べます。
      </p>
      <p>画面OFFや別アプリ表示中でも音が鳴ります。</p>
      <p>※30分を越える時間設定時には、タイマー開始まで数秒時間がかかることがあります。</p>

      <hr style={{
        margin: "22px 0",
        border: 0,
        borderTop: "1px solid var(--ink-dim)",
      }} />

      <p>・このアプリは、TENTの青木が作りました。</p>
      <p>
        ・TENTの他のプロジェクト<br />
        <a href="https://tempo.tent1000.com/" target="_blank" rel="noopener noreferrer" style={linkStyle}>
          TENTのTEMPO
        </a>
      </p>
      <p>
        ・お問い合わせ・感想<br />
        <a href="https://x.com/aoki_TENT" target="_blank" rel="noopener noreferrer" style={linkStyle}>
          @aoki_tent
        </a>
      </p>

      <p style={{
        marginTop: "2.5em",
        marginBottom: 0,
        fontSize: 11,
        color: "var(--ink-dim)",
        letterSpacing: "0.04em",
        opacity: 0.7,
      }}>
        build {version}
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
        padding: "15px 14px 7px",
        lineHeight: 1,
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
      paddingTop: "0.18em",
      display: "inline-flex",
      alignItems: "center",
    }}>
      <span>{mm}</span>
      <span style={{
        display: "inline-block",
        transform: "translateY(-0.20em)",
        margin: "0 0.02em",
      }}>:</span>
      <span>{rr}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// アクションボタン (START / PAUSE / RESUME / RESET / NEW)
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
        padding: "28px 14px 18px",
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
        padding: "12px 10px 4px",
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
