"use client";

import { useEffect } from "react";
import { saveAnonymousReading } from "@/lib/anonymous/localState";

export default function ReaderProgressTracker({ seriesId, chapterId }: { seriesId: string; chapterId: string | null }) {
  useEffect(() => {
    if (!chapterId) return;
    const now = new Date().toISOString();

    void saveAnonymousReading({
      seriesId,
      chapterId,
      lastPageNumber: 1,
      lastReadAt: now,
    });

    void fetch("/api/reading-progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesId, chapterId, lastPageNumber: 1, lastReadAt: now }),
    });
  }, [seriesId, chapterId]);

  return null;
}
