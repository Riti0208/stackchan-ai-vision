import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { RobotConnection } from "./connection";
import { LoadingOverlay } from "./LoadingOverlay";
import { emotionKeys } from "./protocol";
import type { Personality, Decision } from "./protocol";
const robot = new RobotConnection();
const personalityNames: Record<Personality, string> = {
  curious: "好奇心旺盛",
  shy: "照れ屋",
  cheerful: "陽気",
  calm: "おっとり",
  cautious: "慎重",
  playful: "いたずら好き",
};
const emotionNames = {
  happiness: "よろこび",
  curiosity: "好奇心",
  excitement: "わくわく",
  shyness: "照れ",
  trust: "安心感",
};
const actionNames: Record<string, string> = {
  idle: "静かに待っています",
  look_at: "あなたに注目",
  nod: "そっとうなずく",
  shake: "首を横に振る",
  happy: "うれしさを動きに",
};
const displayNames = {
  happiness: "Happiness",
  curiosity: "Curiosity",
  excitement: "Excitement",
  shyness: "Shyness",
  trust: "Trust",
};
function EyeMark() {
  return (
    <svg viewBox="0 0 76 48" aria-hidden="true" className="eye-mark">
      <defs>
        <linearGradient id="eye" x2="1" y2="1">
          <stop stopColor="#edffff" />
          <stop offset="1" stopColor="#32d8f2" />
        </linearGradient>
      </defs>
      <path
        d="M3 24 23 5h30l20 19-20 19H23Z"
        fill="#0b2437"
        stroke="url(#eye)"
        strokeWidth="2"
      />
      <path d="M9 24 25 10h26l16 14-16 14H25Z" fill="none" stroke="#1d718c" />
      <circle cx="38" cy="24" r="17" fill="url(#eye)" />
      <circle cx="38" cy="24" r="11" fill="#061321" />
      <circle cx="40" cy="21" r="7" fill="#70eaff" />
      <circle cx="43" cy="18" r="3" fill="#efffff" />
    </svg>
  );
}
function activityText(d: Decision) {
  if (!d.reaction.command_issued) return "いまの反応を続けています";
  if (d.human_action?.changes.includes("hand_raised"))
    return "手を上げたことに気づいた";
  if (d.human_action?.changes.includes("smile_started"))
    return "笑顔を見つけた";
  if (d.reaction.trigger === "dialogue") return "相手の言葉に反応";
  return actionNames[d.selected_action] || d.selected_action;
}
export default function App() {
  const s = useSyncExternalStore(robot.subscribe, robot.getSnapshot);
  const [now, setNow] = useState(Date.now());
  const [booting, setBooting] = useState(true);
  const finishBoot = useCallback(() => setBooting(false), []);
  useEffect(() => {
    robot.start();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      robot.stop();
    };
  }, []);
  const live =
    s.connection === "connected" &&
    s.online &&
    s.frame !== null &&
    now - s.lastFrame < 5000;
  const connected = s.connection === "connected" && s.online;
  const status =
    s.connection === "error"
      ? "DISCONNECTED"
      : s.connection === "retrying"
        ? "RECONNECTING"
        : s.connection === "connecting"
          ? "CONNECTING"
          : !s.online
            ? "WAITING FOR ROBOT"
            : !live
              ? "WAITING FOR VIDEO"
              : "CONNECTED";
  const last = s.logs[0]?.data;
  return (
    <div className="app-shell" aria-busy={booting}>
      <LoadingOverlay
        connection={s.connection}
        vision={s.vision}
        onComplete={finishBoot}
      />
      <header className="masthead" inert={booting}>
        <a
          href={location.pathname + location.search}
          className="brand"
          aria-label="StackChan AI Vision"
        >
          <EyeMark />
          <h1>
            STACKCHAN <span className="brand-slash">/</span>{" "}
            <span className="brand-light">AI VISION</span>
          </h1>
        </a>
        <span className="brand-caption">VISION INTERFACE</span>
        <div className="header-status">
          {s.mode === "mock" && (
            <span
              className="demo-badge"
              title="バックエンドが模擬の観察・本音を配信しています"
            >
              DEMO
            </span>
          )}
          <span className={`connection ${live ? "is-live" : ""}`} role="status">
            <i />
            {status}
          </span>
        </div>
      </header>
      <main inert={booting}>
        {s.notice && (
          <div className="notice" role="alert">
            <span>{s.notice}</span>
            {s.connection === "error" && (
              <button onClick={robot.retry}>
                再接続 <span aria-hidden="true">↻</span>
              </button>
            )}
          </div>
        )}
        {connected && s.paidActive === false && s.mode !== null && (
          <div className="notice" role="status">
            {s.paidReason === "call_limit"
              ? `AI実APIは呼び出し上限に達して停止しています${s.paidCallsUsed !== null && s.paidCallsMax !== null ? `（${s.paidCallsUsed}/${s.paidCallsMax}回）` : ""}。映像接続とは別の状態です。`
              : s.mode === "mock"
                ? "AIは模擬モードで動作中です。実APIセッションを確認してください。映像接続とは別の状態です。"
                : "AIの実行セッションは停止中です。映像は引き続き受信できます。"}
          </div>
        )}
        <div className="dashboard">
          <section
            className="panel vision-panel"
            aria-labelledby="vision-title"
          >
            <div className="panel-body">
              <header className="panel-header">
                <h2 id="vision-title">LIVE VISION</h2>
                <span className="panel-subtitle">ロボットの目線</span>
                <span className="header-line" />
              </header>
              <div className="viewport-frame">
                <div
                  className="viewport"
                  style={
                    {
                      aspectRatio: `${s.width}/${s.height}`,
                      "--frame-ratio": s.width / s.height,
                    } as React.CSSProperties
                  }
                >
                  <canvas
                    ref={robot.setCanvas}
                    width={320}
                    height={240}
                    aria-label="スタックチャンのライブカメラ映像"
                    className={s.frame === null ? "empty-canvas" : ""}
                  />
                  <div className="view-grid" aria-hidden="true" />
                  <span className={`live-badge ${live ? "is-live" : ""}`}>
                    <i />
                    {live ? "LIVE" : s.frame !== null ? "PAUSED" : "STANDBY"}
                  </span>
                  {s.frame === null && (
                    <div className="camera-empty">
                      <svg viewBox="0 0 80 80" aria-hidden="true">
                        <path d="M5 26V8h18M57 8h18v18M75 54v18H57M23 72H5V54" />
                        <circle cx="40" cy="40" r="17" />
                        <path d="M40 17v12m0 22v12M17 40h12m22 0h12" />
                      </svg>
                      <strong>
                        {connected
                          ? "映像の到着を待っています"
                          : "スタックチャンを待っています"}
                      </strong>
                      <span>
                        {s.connection === "error"
                          ? "接続を確認して、再接続してください"
                          : s.connection === "retrying"
                            ? "接続を再試行しています"
                            : "映像が届くと、ここに表示されます"}
                      </span>
                    </div>
                  )}
                  {s.frame !== null && !live && (
                    <div className="stale-video">映像の更新を待っています</div>
                  )}
                  {live &&
                    s.faces.map((f) => (
                      <div
                        key={f.id}
                        className={`face-box ${s.primary === f.id ? "primary" : ""}`}
                        style={{
                          left: `${f.x * 100}%`,
                          top: `${f.y * 100}%`,
                          width: `${f.width * 100}%`,
                          height: `${f.height * 100}%`,
                        }}
                      >
                        <span>
                          FACE {String(f.id + 1).padStart(2, "0")} ·{" "}
                          {Math.round(f.confidence * 100)}%
                        </span>
                        <i />
                        <i />
                        <i />
                        <i />
                      </div>
                    ))}
                  <div className="viewport-bottom">
                    <span>
                      {s.frame === null
                        ? "AWAITING SIGNAL"
                        : `#${String(s.frame).padStart(6, "0")}`}
                    </span>
                    <span>
                      {s.frame === null ? "" : `${s.width} × ${s.height}`}
                    </span>
                  </div>
                  <div className="viewport-corners" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
              <div className="vision-footnote">
                <span
                  className={`detector-state ${s.vision === "error" ? "is-error" : ""}`}
                >
                  {s.vision === "loading"
                    ? "顔検出を準備中"
                    : s.vision === "error"
                      ? "顔検出を利用できません（映像は継続）"
                      : "FACE DETECTION ACTIVE"}
                </span>
                <span className="footnote-rule" />
              </div>
            </div>
          </section>
          <div className="right-column">
            <section className="panel mind-panel" aria-labelledby="mind-title">
              <div className="panel-body">
                <header className="panel-header">
                  <h2 id="mind-title">INNER WORLD</h2>
                  <span className="panel-subtitle">スタックチャンの気持ち</span>
                  <span className="personality">
                    {s.mind
                      ? `性格：${personalityNames[s.mind.personality]}`
                      : "性格：—"}
                  </span>
                </header>
                <div className="inner-content">
                  <div className="thought">
                    <svg
                      viewBox="0 0 600 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <path d="M0 40 Q60 0 120 40T240 40T360 40T480 40T600 40M0 60Q75 15 150 60T300 60T450 60T600 60M0 70Q100 5 200 70T400 70T600 70" />
                    </svg>
                    <span className="section-label">いまの本音</span>
                    <p data-testid="thought">
                      {s.mind?.thought || "本音を待っています。"}
                    </p>
                    {!s.mind && (
                      <span className="waiting-label">
                        接続後の本音を待っています
                      </span>
                    )}
                  </div>
                  {s.mind?.generation?.provider === "fallback" && (
                    <p className="fallback-note">
                      文章の生成を休止中のため、定型文を表示しています。
                    </p>
                  )}
                  <div className="behavior">
                    <span className="section-label">外に見せる動き</span>
                    {s.behavior ? (
                      <>
                        <span
                          className={`action-badge action-${s.behavior.command.action}`}
                        >
                          {s.behavior.command.action}
                        </span>
                        <p>{s.behavior.display_text}</p>
                      </>
                    ) : (
                      <p className="muted">反応を待っています</p>
                    )}
                  </div>
                  <div className="emotion-list" aria-label="ロボットの仮想感情">
                    {emotionKeys.map((key) => {
                      const val = s.emotion?.[key];
                      return (
                        <div key={key} className={`emotion emotion-${key}`}>
                          <span
                            className="emotion-name"
                            title={emotionNames[key]}
                          >
                            {displayNames[key]}
                          </span>
                          <div
                            className="meter"
                            role="meter"
                            aria-label={emotionNames[key]}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={
                              val === undefined
                                ? undefined
                                : Math.round(val * 100)
                            }
                            aria-valuetext={
                              val === undefined
                                ? "未受信"
                                : `${Math.round(val * 100)}%`
                            }
                          >
                            <div
                              className="meter-fill"
                              style={{
                                width:
                                  val === undefined ? "0%" : `${val * 100}%`,
                              }}
                            />
                            <span className="meter-lines" aria-hidden="true" />
                          </div>
                          <span className="emotion-value">
                            {val === undefined ? "—" : Math.round(val * 100)}
                            <small>{val === undefined ? "" : "%"}</small>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="emotion-note">ロボットの仮想的な感情です</p>
                </div>
              </div>
            </section>
            <section
              className="panel activity-panel"
              aria-labelledby="activity-title"
            >
              <div className="panel-body">
                <header className="panel-header">
                  <h2 id="activity-title">AI ACTIVITY</h2>
                  <span className="panel-subtitle">見て、考えて、動く</span>
                  <span className="activity-count">
                    {String(s.logs.length).padStart(2, "0")}
                    <span> / 20</span>
                  </span>
                </header>
                <div
                  className="activity-scroll"
                  tabIndex={0}
                  aria-label="AI判断の履歴"
                >
                  {!s.logs.length && (
                    <div className="activity-empty">
                      <span className="pulse-line" />
                      <p>最初のひらめきを待っています</p>
                      <small>AIの観察と判断がここに届きます</small>
                    </div>
                  )}
                  <ol className="activity-list">
                    {s.logs.map((log, index) => (
                      <li key={log.id} className={index === 0 ? "latest" : ""}>
                        <time dateTime={new Date(log.timestamp).toISOString()}>
                          {new Date(log.timestamp).toLocaleTimeString("ja-JP", {
                            hour12: false,
                          })}
                        </time>
                        <span
                          className={`event-dot action-${log.data.selected_action}`}
                          aria-hidden="true"
                        />
                        <span
                          className={`action-badge action-${log.data.selected_action}`}
                        >
                          {log.data.selected_action}
                        </span>
                        <div className="event-detail">
                          <p>{activityText(log.data)}</p>
                          {index === 0 && (
                            <div className="observations">
                              <span>
                                Smile{" "}
                                <b>
                                  {Math.round(
                                    log.data.observations.smiling * 100,
                                  )}
                                  %
                                </b>
                              </span>
                              <span>
                                Looking{" "}
                                <b>
                                  {Math.round(
                                    log.data.observations.looking_at_robot *
                                      100,
                                  )}
                                  %
                                </b>
                              </span>
                            </div>
                          )}
                        </div>
                        <span className="event-confidence" title="判断の確信度">
                          {Math.round(log.data.confidence * 100)}
                          <small>%</small>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="activity-footer">
                  <i />
                  <span>
                    {last
                      ? "LATEST OBSERVATION RECEIVED"
                      : "LISTENING FOR OBSERVATIONS"}
                  </span>
                  <span className="footer-ticks" />
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
