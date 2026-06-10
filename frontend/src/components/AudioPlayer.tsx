"use client";
// The original-recording player. Unmistakably labeled so a judge understands the input is a REAL
// recorded consultation in Brazilian Portuguese — not a canned transcript. Clicking plays the actual
// audio (presigned from S3 by the backend). Degrades to a clear "unavailable" if the link can't load.
import { useRef, useState } from "react";

function fmt(s: number): string {
  if (!isFinite(s) || s <= 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function AudioPlayer({ src, name }: { src: string; name: string | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [err, setErr] = useState(false);

  function toggle() {
    const a = ref.current;
    if (!a) return;
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => setErr(true));
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = ref.current;
    if (!a || !dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  }

  return (
    <div className="audio-player">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
        onError={() => setErr(true)}
      />
      <button className="ap-play" onClick={toggle} disabled={err} aria-label={playing ? "Pause recording" : "Play original recording"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="ap-main">
        <div className="ap-label">
          <span className="ap-rec" />
          Original recording · <span className="ap-strong">real consultation</span> · Brazilian Portuguese
          {name && <span className="ap-file">{name}</span>}
        </div>
        <div className="ap-bar" onClick={seek} title="Click to seek">
          <span className="ap-fill" style={{ width: dur ? `${(cur / dur) * 100}%` : "0%" }} />
        </div>
      </div>
      <div className="ap-time mono">{err ? "unavailable" : `${fmt(cur)} / ${fmt(dur)}`}</div>
    </div>
  );
}
