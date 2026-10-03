"use client";

import type { MouseEvent, ReactNode } from "react";

const SCROLL_RATIO = 0.38;

export default function ReaderClickScroll({ children }: { children: ReactNode }) {
  function handleClick(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if (window.matchMedia("(max-width: 767px), (pointer: coarse)").matches) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Do not hijack normal controls, links, text selection, or explicitly
    // interactive elements inside the reader.
    if (
      target.closest(
        "a,button,input,textarea,select,option,[role='button'],[contenteditable='true'],[data-no-reader-scroll]"
      )
    ) {
      return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().trim()) return;

    const amount = Math.max(120, Math.round(window.innerHeight * SCROLL_RATIO));
    window.scrollBy({ top: amount, behavior: "smooth" });
  }

  return (
    <section className="reader-pages" onClick={handleClick}>
      {children}
    </section>
  );
}
