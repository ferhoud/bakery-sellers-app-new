// pages/login.js
import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { isAdminEmail } from "../lib/admin"; // <- important (si ton projet utilise "@/lib/admin", adapte le chemin)

function safeStr(x) {
  return (x ?? "").toString();
}

function safeNextPath(x) {
  const s = safeStr(x);
  if (!s) return "";
  if (!s.startsWith("/")) return "";
  if (s.startsWith("//")) return "";
  return s;
}

function pickDefaultRedirect(role) {
  if (role === "admin") return "/admin";
  if (role === "supervisor") return "/supervisor";
  return "/app";
}

// Empêche les boucles: un vendeur ne doit jamais être renvoyé vers /supervisor ou /admin via ?next=
function sanitizeNextForRole(role, nextPath) {
  const p = safeNextPath(nextPath);
  if (!p) return "";

  // sécurité basique
  if (p.startsWith("/api")) return "";
  if (p.startsWith("/login")) return "";
  if (p.startsWith("/logout")) return "";

  // garde-fous par rôle
  if (p.startsWith("/supervisor") && role !== "supervisor") return "";
  if (p.startsWith("/admin") && role !== "admin") return "";

  return p;
}

export default function LoginPage() {
  const router = useRouter();

  const nextPath = useMemo(() => safeNextPath(router.query?.next), [router.query]);
  const stay = useMemo(() => safeStr(router.query?.stay) === "1", [router.query]);
  const kiosk = useMemo(() => safeStr(router.query?.kiosk) === "1", [router.query]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function getRoleFromApi(accessToken) {
    const r = await fetch("/api/role", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`role (${r.status}) ${t}`);
    }
    const j = await r.json().catch(() => ({}));
    return (j?.role || "seller").toString().toLowerCase();
  }

  // Rôle: admin d’abord (local, fiable), sinon API role
  async function resolveRole({ accessToken, userEmail }) {
    const em = (userEmail || "").toString().trim().toLowerCase();
    if (em && isAdminEmail(em)) return "admin";

    try {
      return await getRoleFromApi(accessToken);
    } catch (e) {
      // fallback si API indispo: au pire "seller"
      return "seller";
    }
  }

  async function signOutAndStay(message) {
    try {
      await supabase.auth.signOut();
    } catch {}
    if (message) setErr(message);
  }

  async function redirectAfterLogin({ accessToken, userEmail }) {
    const role = await resolveRole({ accessToken, userEmail });

    // Mode tablette/kiosk : on n'autorise QUE le superviseur
    if (kiosk) {
      if (role !== "supervisor") {
        await signOutAndStay(
          "Cette tablette est réservée au superviseur. Veuillez vous connecter avec le compte superviseur."
        );
        return;
      }
      const dest =
        nextPath && nextPath.startsWith("/supervisor") ? nextPath : "/supervisor/checkin?stay=1";
      router.replace(dest);
      return;
    }

    // Mode normal : on respecte ?next= uniquement si compatible avec le rôle
    const safeNext = sanitizeNextForRole(role, nextPath);
    if (safeNext) {
      router.replace(safeNext);
      return;
    }

    router.replace(pickDefaultRedirect(role));
  }

  async function doLogin(e) {
    e?.preventDefault?.();
    setErr("");
    setLoading(true);

    try {
      const em = email.trim();

      const { data, error } = await supabase.auth.signInWithPassword({
        email: em,
        password,
      });

      if (error) throw error;

      const token = data?.session?.access_token;
      const userEmail = data?.session?.user?.email || em;

      if (!token) throw new Error("Session manquante");

      if (stay) {
        const url = new URL(window.location.href);
        url.searchParams.set("stay", "1");
        window.history.replaceState({}, "", url.toString());
      }

      await redirectAfterLogin({ accessToken: token, userEmail });
    } catch (e2) {
      setErr(e2?.message || "Erreur de connexion");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Si déjà connecté, on redirige direct (utile après refresh / PWA)
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const userEmail = data?.session?.user?.email || "";
      if (!token) return;

      try {
        await redirectAfterLogin({ accessToken: token, userEmail });
      } catch {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Head>
        <title>Connexion</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div style={{ maxWidth: 520, margin: "0 auto", padding: 16 }}>
        <div className="card">
          <div className="hdr">Connexion</div>

          {kiosk ? (
            <div style={{ marginTop: 8, opacity: 0.85, fontSize: 13 }}>
              Mode tablette superviseur · Connexion requise
            </div>
          ) : (
            <div style={{ marginTop: 8, opacity: 0.75, fontSize: 13 }}>
              {nextPath ? `Redirection après connexion : ${nextPath}` : "Connectez-vous pour accéder à l’application."}
            </div>
          )}

          <form onSubmit={doLogin} style={{ marginTop: 14, display: "grid", gap: 10 }}>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              required
            />
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mot de passe"
              autoComplete="current-password"
              required
            />

            {err ? (
              <div
                style={{
                  padding: "10px 12px",
                  border: "1px solid #ef4444",
                  borderRadius: 12,
                  background: "rgba(239,68,68,.06)",
                }}
              >
                {err}
              </div>
            ) : null}

            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Connexion…" : "Se connecter"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
