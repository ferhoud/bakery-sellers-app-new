// middleware.js à la racine du projet
import { NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/favicon.ico",
  "/manifest.json",
  "/sw.js",
  "/robots.txt",
  "/sitemap.xml",
  "/icon-192.png",
  "/icon-512.png",
  "/images",      // si tu as des images publiques
  "/icons",       // si tu as un dossier d’icônes
  "/_next"        // assets Next.js
];

export function middleware(req) {
  const { pathname } = req.nextUrl;

  // Laisse passer tous les assets publics
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // Exemple minimal d’auth (à adapter à ton app)
  // Si tu as une cookie de session, vérifie-la ici.
  // Sinon, laisse passer et gère l’auth côté pages.
  return NextResponse.next();
}

// On fait matcher TOUT sauf ce qui est explicitement public
export const config = {
  matcher: [
    "/((?!favicon.ico|manifest.json|sw.js|robots.txt|sitemap.xml|icon-192.png|icon-512.png|images/.*|icons/.*|_next/.*).*)",
  ],
};
