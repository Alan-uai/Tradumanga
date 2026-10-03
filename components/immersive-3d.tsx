"use client";

import { useEffect, useMemo, useState } from "react";

type Immersive3DProps = {
  variant?: "hero" | "input" | "processing" | "reader";
  progress?: number;
  label?: string;
};

export default function Immersive3D({
  variant = "hero",
  progress = 0,
  label,
}: Immersive3DProps) {
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  const clamped = Math.max(0, Math.min(100, progress));
  const vars = useMemo(
    () =>
      ({
        "--mx": pointer.x * 18 + "px",
        "--my": pointer.y * 12 + "px",
        "--progress": clamped + "%",
      }) as React.CSSProperties,
    [pointer, clamped],
  );

  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (reduced) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    setPointer({ x, y });
  }

  return (
    <div
      className={"motion-3d motion-3d--" + variant + (reduced ? " motion-3d--reduced" : "")}
      style={vars}
      onPointerMove={move}
      onPointerLeave={() => setPointer({ x: 0, y: 0 })}
      aria-hidden="true"
    >
      <div className="motion-3d__grid" />
      <div className="motion-3d__glow motion-3d__glow--a" />
      <div className="motion-3d__glow motion-3d__glow--b" />
      <div className="motion-3d__orbit motion-3d__orbit--a" />
      <div className="motion-3d__orbit motion-3d__orbit--b" />
      <div className="motion-3d__core">
        <span className="motion-3d__core-face motion-3d__core-face--front">
          {variant === "processing" ? Math.round(clamped) + "%" : "T"}
        </span>
        <span className="motion-3d__core-face motion-3d__core-face--back" />
        <span className="motion-3d__core-face motion-3d__core-face--left" />
        <span className="motion-3d__core-face motion-3d__core-face--right" />
        <span className="motion-3d__core-face motion-3d__core-face--top" />
        <span className="motion-3d__core-face motion-3d__core-face--bottom" />
      </div>
      <div className="motion-3d__scanner" />
      <div className="motion-3d__particles">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={index} style={{ "--i": index } as React.CSSProperties} />
        ))}
      </div>
      {label && <span className="motion-3d__label">{label}</span>}
      {variant === "processing" && (
        <div className="motion-3d__progress">
          <span style={{ width: clamped + "%" }} />
        </div>
      )}
    </div>
  );
}
