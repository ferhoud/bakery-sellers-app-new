// pages/login.js
import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { isAdminEmail } from "@/lib/admin";

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

function sanitizeNextForRole(role, nextPath) {
  const p = safeNextPath(nextPath);
  if (!p) return "";
  if (p.startsWith("/api")) return "";
  if (p.startsWith("/login")) return "";
  if (p.startsWith("/logout")) return "";
  // /app est réservé aux vendeuses: l'admin y est expulsé par sécurité
  if (role === "admin" && p.startsWith("/app")) return "";
  // /app n'est pas l'écran superviseur non plus
  if (role === "supervisor" && p.startsWith("/app")) return "";
  if (p.startsWith("/supervisor") && role !== "supervisor") return "";
  if (p.startsWith("/admin") && role !== "admin") return "";
  return p;
}

async function callRoleApi(accessToken) {
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

function collectKeys(st) {
  const out = [];
  try {
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i);
      if (k) out.push(k);
    }
  } catch (_) {}
  return out;
}

function shouldRemoveKey(k) {
  return (
    k.startsWith("sb-") ||
    k.includes("supabase") ||
    k.includes("auth-token") ||
    k.includes("token") ||
    k.includes("refresh") ||
    k.includes("LAST_OPEN_PATH")
  );
}

async function hardSignOut({ next = "/app" } = {}) {
  try {
    await supabase.auth.signOut();
  } catch {}
  if (typeof window !== "undefined") {
    try {
      const ls = window.localStorage;
      const ss = window.sessionStorage;
      collectKeys(ls).forEach((k) => {
        if (shouldRemoveKey(k)) ls.removeItem(k);
      });
      collectKeys(ss).forEach((k) => {
        if (shouldRemoveKey(k)) ss.removeItem(k);
      });
    } catch {}
    // Optionnel: si l'API existe dans ton projet, ça purge aussi les cookies éventuels
    try {
      await fetch("/api/purge-cookies", { method: "POST" }).catch(() => null);
    } catch {}
    window.location.replace(`/login?stay=1&next=${encodeURIComponent(next)}&cleared=1`);
  }
}

export default function LoginPage() {
  const router = useRouter();

  const nextPath = useMemo(() => safeNextPath(router.query?.next), [router.query]);
  const stay = useMemo(() => safeStr(router.query?.stay) === "1", [router.query]);
  const kiosk = useMemo(() => safeStr(router.query?.kiosk) === "1", [router.query]);
  const switchMode = useMemo(() => safeStr(router.query?.switch) === "1", [router.query]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [existingEmail, setExistingEmail] = useState("");

  async function resolveRole({ accessToken, userEmail }) {
    const em = (userEmail || "").toString().trim().toLowerCase();
    if (em && isAdminEmail(em)) return "admin";
    try {
      return await callRoleApi(accessToken);
    } catch {
      return "seller";
    }
  }

  async function redirectAfterLogin({ accessToken, userEmail }) {
    const role = await resolveRole({ accessToken, userEmail });

    // Mode tablette/kiosk : on n'autorise QUE le superviseur
    if (kiosk) {
      if (role !== "supervisor") {
        await hardSignOut({ next: "/supervisor" });
        setErr("Cette tablette est réservée au superviseur. Veuillez vous connecter avec le compte superviseur.");
        return;
      }
      const dest =
        nextPath && nextPath.startsWith("/supervisor") ? nextPath : "/supervisor/checkin?stay=1";
      router.replace(dest);
      return;
    }

    const safeNext = sanitizeNextForRole(role, nextPath);
    router.replace(safeNext || pickDefaultRedirect(role));
  }

  async function doLogin(e) {
    e?.preventDefault?.();
    setErr("");
    setLoading(true);

    try {
      // Si une session existe (vendeuse -> admin, admin -> vendeuse), on purge avant de se reconnecter
      const { data: sess } = await supabase.auth.getSession();
      if (sess?.session?.user) {
        await supabase.auth.signOut().catch(() => null);
        if (typeof window !== "undefined") {
          try {
            const ls = window.localStorage;
            const ss = window.sessionStorage;
            collectKeys(ls).forEach((k) => {
              if (shouldRemoveKey(k)) ls.removeItem(k);
            });
            collectKeys(ss).forEach((k) => {
              if (shouldRemoveKey(k)) ss.removeItem(k);
            });
          } catch {}
          try {
            await fetch("/api/purge-cookies", { method: "POST" }).catch(() => null);
          } catch {}
        }
      }

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
    let alive = true;

    (async () => {
      // Si /login?swtich=1 : on force une vraie déconnexion puis on reste sur la page
      if (switchMode) {
        await hardSignOut({ next: nextPath || "/app" });
        return;
      }

      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const uem = data?.session?.user?.email || "";
      if (!alive) return;

      setExistingEmail(uem || "");

      // KIOSK: si déjà connecté superviseur, on peut rediriger (pratique sur tablette)
      if (kiosk && token) {
        try {
          await redirectAfterLogin({ accessToken: token, userEmail: uem });
        } catch {}
      }

      // Mode normal : on NE redirige pas automatiquement.
      // Ça évite les boucles et permet de changer de compte facilement.
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiosk, switchMode]);

  return (
    <>
      <Head>
        <title>Connexion</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div style={{ maxWidth: 560, margin: "0 auto", padding: 16 }}>
        <div className="card">
          <div className="hdr">Connexion</div>

          {existingEmail ? (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,.12)",
                opacity: 0.95,
              }}
            >
              <div style={{ fontSize: 13, opacity: 0.8 }}>Session active :</div>
              <div style={{ fontWeight: 600, marginTop: 2 }}>{existingEmail}</div>

              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => hardSignOut({ next: nextPath || "/app" })}
                  disabled={loading}
                >
                  Changer de compte
                </button>

                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    try {
                      const { data } = await supabase.auth.getSession();
                      const token = data?.session?.access_token;
                      const em = data?.session?.user?.email || "";
                      if (!token) return;
                      await redirectAfterLogin({ accessToken: token, userEmail: em });
                    } catch {}
                  }}
                  disabled={loading}
                >
                  Continuer
                </button>
              </div>
            </div>
          ) : null}

          {kiosk ? (
            <div style={{ marginTop: 10, opacity: 0.85, fontSize: 13 }}>
              Mode tablette superviseur · Connexion requise
            </div>
          ) : (
            <div style={{ marginTop: 10, opacity: 0.75, fontSize: 13 }}>
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
