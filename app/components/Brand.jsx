// Image Lift brand primitives: the rising-bars logo mark, a decorative
// ascending-bars graphic, a four-point sparkle accent, a circular usage gauge
// and a smooth linear meter.

export function LiftMark({ size = 22 }) {
  return (
    <svg className="il-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="url(#il-mark-grad)" />
      <path d="M7 16.5v-3M12 16.5v-6.5M17 16.5V7.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <defs>
        <linearGradient id="il-mark-grad" x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1A23B8" />
          <stop offset="1" stopColor="#4C5BFF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// Ascending bars used as a quiet background flourish on hero surfaces.
const BAR_HEIGHTS = [28, 40, 34, 52, 46, 64, 58, 78, 72, 92];

export function RisingBars({ className = "" }) {
  return (
    <span className={`il-bars ${className}`} aria-hidden="true">
      {BAR_HEIGHTS.map((h, i) => (
        <i key={i} style={{ height: `${h}%` }} />
      ))}
    </span>
  );
}

// Four-point sparkle used as a corner accent on blue hero surfaces.
export function Sparkle({ size = 28, style }) {
  return (
    <span className="il-sparkle" style={style} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path d="M12 0c.9 6.4 5.6 11.1 12 12-6.4.9-11.1 5.6-12 12-.9-6.4-5.6-11.1-12-12C6.4 11.1 11.1 6.4 12 0z" fill="currentColor" />
      </svg>
    </span>
  );
}

// Circular gauge. `pct` is 0–100; children render in the centre.
export function RingGauge({ pct = 0, size = 148, stroke = 12, label, children }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const full = clamped >= 100;
  return (
    <div className={`il-ring${full ? " is-full" : ""}`} style={{ width: size, height: size }} role="img" aria-label={label || `${Math.round(clamped)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="il-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#A9B6FF" />
          </linearGradient>
        </defs>
        <circle className="il-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="il-ring-value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="il-ring-center">{children}</div>
    </div>
  );
}

// Smooth linear meter with a gradient fill. `quota` turns it amber when full
// (used for credit meters, where 100% means "out of credits").
export function Meter({ pct = 0, dark = false, quota = false, label }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div
      className={`il-meter${dark ? " il-meter--dark" : ""}${quota && clamped >= 100 ? " is-full" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
    >
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}
