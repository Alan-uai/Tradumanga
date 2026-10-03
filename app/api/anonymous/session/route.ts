import { NextResponse } from "next/server";
import { getOrCreateAnonymousSession } from "@/lib/anonymous/session";

export async function POST() {
  try {
    const session = await getOrCreateAnonymousSession();
    return NextResponse.json({ sessionId: session.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao iniciar sessão anônima." }, { status: 500 });
  }
}
