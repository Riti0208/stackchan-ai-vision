import { useEffect, useState } from "react";
import type { RobotState } from "./connection";

/** One boot transition per page load; an offline robot must not trap the viewer. */
export function LoadingOverlay({
  connection,
  vision,
  onComplete,
}: Pick<RobotState, "connection" | "vision"> & { onComplete: () => void }) {
  const [minimumElapsed, setMinimumElapsed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [hidden, setHidden] = useState(false);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const minimum = setTimeout(
      () => setMinimumElapsed(true),
      reducedMotion ? 0 : 1000,
    );
    const deadline = setTimeout(() => setExpired(true), 10000);
    return () => {
      clearTimeout(minimum);
      clearTimeout(deadline);
    };
  }, [reducedMotion]);

  const ready =
    (connection === "connected" && vision !== "loading") ||
    connection === "error" ||
    expired;
  useEffect(() => {
    if (minimumElapsed && ready) setLeaving(true);
  }, [minimumElapsed, ready]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(
      () => {
        setHidden(true);
        onComplete();
      },
      reducedMotion ? 80 : 900,
    );
    return () => clearTimeout(timer);
  }, [leaving, onComplete, reducedMotion]);

  if (hidden) return null;
  return (
    <div
      className={`boot-overlay${leaving ? " is-leaving" : ""}`}
      data-testid="boot-overlay"
      role="status"
      aria-live="polite"
      aria-label="AI Visionを準備しています"
    >
      <div className="boot-edge" aria-hidden="true" />
      <div className="boot-content">
        <span className="boot-overline">VISION LINK</span>
        <div className="boot-optics" aria-hidden="true">
          <div className="boot-halo" />
          <svg viewBox="0 0 400 400" fill="none">
            <defs>
              <radialGradient id="boot-iris">
                <stop offset="0" stopColor="#b4fcff" />
                <stop offset=".48" stopColor="#30c9e9" />
                <stop offset=".75" stopColor="#092a43" />
                <stop offset="1" stopColor="#69edff" />
              </radialGradient>
              <linearGradient id="boot-arc">
                <stop stopColor="#6bf4ff" />
                <stop offset="1" stopColor="#1a789e" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="boot-ring boot-ring-outer">
              <circle
                cx="200"
                cy="200"
                r="167"
                stroke="#316179"
                strokeWidth=".6"
                strokeDasharray="1 4"
              />
              <circle
                cx="200"
                cy="200"
                r="158"
                stroke="#2d728e"
                strokeWidth=".6"
                strokeDasharray="85 20 55 180"
              />
              <path
                d="M200 42 A158 158 0 0 1 348 144"
                stroke="url(#boot-arc)"
                strokeWidth="3"
              />
              <path
                d="M200 358 A158 158 0 0 1 52 256"
                stroke="url(#boot-arc)"
                strokeWidth="3"
              />
              <circle cx="53" cy="258" r="3" fill="#7affff" />
            </g>
            <g className="boot-ring boot-ring-inner">
              <circle
                cx="200"
                cy="200"
                r="132"
                stroke="#508799"
                strokeWidth=".7"
                strokeDasharray="1 7"
              />
              <circle
                cx="200"
                cy="200"
                r="142"
                stroke="#3c7b95"
                strokeWidth=".5"
                strokeDasharray="125 40 150 80"
              />
              <circle
                cx="293"
                cy="107"
                r="3"
                fill="#ffca89"
                className="boot-amber"
              />
              <circle
                cx="107"
                cy="293"
                r="3"
                fill="#ffca89"
                className="boot-amber"
              />
            </g>
            <path
              d="M200 21V62M200 338v41M21 200h41m276 0h41"
              stroke="#4cb2ce"
              strokeWidth=".6"
            />
            <circle cx="200" cy="42" r="2" fill="#8affff" />
            <circle cx="200" cy="358" r="2" fill="#8affff" />
            <path
              d="M65 200 Q200 63 335 200 Q200 337 65 200Z"
              stroke="#b9f6ff"
              strokeWidth="1.6"
              className="boot-eye-outline"
            />
            <circle
              cx="200"
              cy="200"
              r="61"
              fill="url(#boot-iris)"
              fillOpacity=".85"
              stroke="#9bffff"
            />
            <g className="boot-iris-lines">
              {Array.from({ length: 80 }, (_, i) => (
                <path
                  key={i}
                  d="M200 143v22"
                  stroke={i % 4 === 0 ? "#a9ffff" : "#36bad8"}
                  strokeWidth={i % 4 === 0 ? ".7" : ".4"}
                  transform={`rotate(${i * 4.5} 200 200)`}
                />
              ))}
            </g>
            <circle
              cx="200"
              cy="200"
              r="28"
              fill="#031322"
              stroke="#58c1dd"
              strokeWidth=".5"
            />
            <circle
              cx="212"
              cy="182"
              r="7"
              fill="#a4ffff"
              fillOpacity=".6"
              className="boot-eye-glint"
            />
            <circle cx="200" cy="200" r="2" fill="#9ef9ff" />
          </svg>
          <span className="boot-scan" />
        </div>
        <div className="boot-brand">
          STACKCHAN <span>/</span> AI VISION
        </div>
        <p className="boot-caption">視界をつないでいます</p>
        <div className="boot-rail" aria-hidden="true">
          <i />
        </div>
        <span className="boot-stage">
          {expired || connection === "error"
            ? "接続状態を確認しています"
            : connection !== "connected"
              ? "映像サーバーに接続しています"
              : vision === "loading"
                ? "顔検出を準備しています"
                : "準備ができました"}
        </span>
      </div>
    </div>
  );
}
