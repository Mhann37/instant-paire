import { NextResponse } from "next/server";

// Server OCR fallback is intentionally a stub: Tesseract runs client-side in v1
// (zero server cost, works on Vercel free). This endpoint exists so a future
// Vision-model upgrade (GPT-4o vision) slots in without UI changes.
export async function POST() {
  return NextResponse.json(
    { error: "Server OCR not enabled — photo is read on-device. If reading fails, tap Edit wines and fix names manually." },
    { status: 501 }
  );
}
