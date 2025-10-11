// middleware.js (temporaire : ne bloque rien)
import { NextResponse } from "next/server";
export function middleware() {
  return NextResponse.next();
}
