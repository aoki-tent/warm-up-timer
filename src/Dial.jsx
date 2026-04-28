import React, { useEffect, useRef, useState } from "react";

// ───────────────────────────────────────────────────────────
// 60分文字盤ダイアル (キッチンタイマー方式)
// - 60本のティックを 6° 間隔で 12 時から時計回りに配置
// - 残り/設定時間に応じて 12 時から先頭ぶんが「黒く点灯」
// - 経過に応じて末端 (時計回りに進んだ側) から順に消える
// - 12/3/6/9 位置のティックは少しだけ長く / 太く
// - finished では HSL レインボーが全周をチェイス
// ───────────────────────────────────────────────────────────

const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2;

// 180本のティック (3倍密度)。全て同じ長さ・太さ。外端を白丸の縁から少し内側に揃える。
const TICK_COUNT = 180;
const FACE_R   = 160; // 白い円盤の半径 (= SIZE/2)
const TICK_OUT = 152; // 外端
const TICK_IN  = 129; // 内端 (長さ 23)

export function Dial({
  phase,                 // "idle" | "running" | "paused" | "finished"
  durationSec,           // ユーザーが設定した秒数
  remainingSec,          // running/paused 中の残り秒
  centerNode,            // 中央表示 (jsx)
  pulseCenter,           // boolean: paused のとき点滅
  onTapCenter,           // () => void  (idle のみ反応)
}) {
  // 設定時間 = 1周。残り/経過の比率で 60 本のティックを点灯/消灯する。
  // idle: 全60本点灯 / running: remaining / duration の比率 / finished: 0
  const arcRatio =
    phase === "running" || phase === "paused" ? (durationSec > 0 ? remainingSec / durationSec : 0)
    : phase === "finished"                    ? 0
    :                                            1;
  const arcEndDeg = Math.max(0, Math.min(1, arcRatio)) * 360;

  // finished のレインボー offset (rAF で回す)
  const [hueOffset, setHueOffset] = useState(0);
  useEffect(() => {
    if (phase !== "finished") return;
    let raf;
    let last = performance.now();
    const loop = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      // 1周を 2.4s で回す
      setHueOffset((prev) => (prev + dt * 150) % 360);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  return (
    <div className="relative" style={{ width: "100%", height: "100%", aspectRatio: "1 / 1", maxWidth: "100%", maxHeight: "100%" }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block" }}
      >
        {/* 白い円盤 */}
        <circle cx={CX} cy={CY} r={FACE_R} fill="var(--surface)" />

        {/* TICK_COUNT 本のティック (全て同じ長さ・太さ) */}
        {Array.from({ length: TICK_COUNT }).map((_, i) => {
          const deg = (i * 360) / TICK_COUNT;
          const a = ((deg - 90) * Math.PI) / 180;
          const x1 = CX + TICK_IN  * Math.cos(a);
          const y1 = CY + TICK_IN  * Math.sin(a);
          const x2 = CX + TICK_OUT * Math.cos(a);
          const y2 = CY + TICK_OUT * Math.sin(a);

          // 「点灯」しているか? 角度 < arcEndDeg
          const lit = deg < arcEndDeg - 0.001;

          // 色決定
          let stroke;
          if (phase === "finished") {
            stroke = `hsl(${(deg + hueOffset) % 360} 75% 52%)`;
          } else {
            stroke = lit ? "var(--ink)" : "var(--ink-dim)";
          }

          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={stroke}
              strokeWidth={1.0}
              strokeLinecap="butt"
            />
          );
        })}
      </svg>

      {/* 中央コンテンツ (HTML レイヤー) */}
      <button
        type="button"
        onClick={() => phase === "idle" && onTapCenter && onTapCenter()}
        disabled={phase !== "idle"}
        className={pulseCenter ? "paused-blink" : ""}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          outline: "none",
          padding: 0,
          cursor: phase === "idle" ? "text" : "default",
          color: "var(--ink)",
        }}
      >
        {centerNode}
      </button>
    </div>
  );
}
