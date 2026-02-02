// pages/login.js
import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

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
  if (role === "supervisor") return "/supervisor/checkin";
  return "/app";
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

  async function getRole(accessToken) {
    const r = await fetch("/api/role", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`role (${r.status}) ${t}`);
    }
    const j = await r.json().catch(() => ({}));
    return j?.role || "seller";
  }

  async function redirectAfterLogin(accessToken) {
    const role = await getRole(accessToken);

    // Mode tablette / kiosque : on refuse d'ouvrir l'admin ou l'espace vendeuse.
    if (kiosk && role !== "supervisor") {
      try {
        await supabase.auth.signOut();
      } catch {}
      setErr("Cette tablette est en mode superviseur. Veuillez vous connecter avec le compte superviseur.");
      return;
    }

    if (role === "supervisor") {
      // Si nextPath est fourni et reste dans /supervisor, on le respecte.
      if (nextPath && nextPath.startsWith("/supervisor")) {
        router.replace(nextPath);
      } else {
        router.replace("/supervisor/checkin");
      }
      return;
    }

    if (role === "admin") {
      router.replace("/admin");
      return;
    }

    if (nextPath) {
      router.replace(nextPath);
      return;
    }

    router.replace(pickDefaultRedirect(role));
  }

  async function doLogin(e) {
    e?.preventDefault?.();
    setErr("");
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;

      const token = data?.session?.access_token;
      if (!token) throw new Error("Session manquante");

      if (stay) {
        const url = new URL(window.location.href);
        url.searchParams.set("stay", "1");
        if (kiosk) url.searchParams.set("kiosk", "1");
        window.history.replaceState({}, "", url.toString());
      }

      await redirectAfterLogin(token);
    } catch (e2) {
      setErr(e2?.message || "Erreur de connexion");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Si déjà connecté, on redirige direct (utile après refresh / relance PWA)
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return;
      try {
        await redirectAfterLogin(token);
      } catch {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiosk, nextPath]);

  return (
    <>
      <Head>
        <title>Connexion</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div style={{ maxWidth: 520, margin: "0 auto", padding: 16 }}>
        <div className="card">
          <div className="hdr">Connexion</div>
          <div style={{ marginTop: 8, opacity: 0.75, fontSize: 13 }}>
            {kiosk
              ? "Mode superviseur (tablette)."
              : nextPath
              ? `Redirection après connexion : ${nextPath}`
              : "Connectez-vous pour accéder à l’application."}
          </div>

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
