// pages/login.js
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { isAdminEmail } from "../lib/admin";

function safeStr(x) {
  return (x ?? "").toString();
}

// sécurité: on n'autorise que des chemins relatifs
function sanitizeNextPath(n) {
  const s = safeStr(n);
  if (s && s.startsWith("/")) return s;
  return "/app";
}

export default function LoginPage() {
  const router = useRouter();
  const didRedirectRef = useRef(false);

  const nextPath = useMemo(() => {
    if (!router.isReady) return "/app";
    return sanitizeNextPath(router.query?.next);
  }, [router.isReady, router.query?.next]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [sessionInfo, setSessionInfo] = useState("checking"); // checking | none | yes

  const redirectOnce = useCallback(
    async (session) => {
      if (didRedirectRef.current) return;
      if (!router.isReady) return;

      let dest = nextPath || "/app";

      // ✅ Détection admin par email (évite le détour /app -> /admin qui provoque l'abort)
      const em = session?.user?.email || "";
      if (isAdminEmail(em)) {
        if (!dest.startsWith("/admin")) dest = "/admin";
        didRedirectRef.current = true;
        router.replace(dest);
        return;
      }

      // (optionnel) Tentative role via profiles si tu veux garder le système
      // Mais si RLS bloque, on garde dest tel quel et on évite les erreurs.
      try {
        const uid = session?.user?.id;
        if (uid) {
          const { data: prof, error: pErr } = await supabase
            .from("profiles")
            .select("role")
            .eq("user_id", uid)
            .maybeSingle();

          if (!pErr && prof?.role === "admin") {
            if (!dest.startsWith("/admin")) dest = "/admin";
          }
        }
      } catch (_) {}

      didRedirectRef.current = true;
      router.replace(dest);
    },
    [router, nextPath]
  );

  useEffect(() => {
    let alive = true;
    if (!router.isReady) return;

    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!alive) return;

        if (error) {
          setSessionInfo("none");
          setErr(error.message || "getSession error");
          return;
        }

        if (data?.session) {
          setSessionInfo("yes");
          await redirectOnce(data.session);
        } else {
          setSessionInfo("none");
        }
      } catch (e) {
        if (!alive) return;
        setSessionInfo("none");
        setErr(e?.message || String(e));
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_evt, s) => {
      if (!alive) return;
      if (s) {
        setSessionInfo("yes");
        await redirectOnce(s);
      } else {
        setSessionInfo("none");
      }
    });

    return () => {
      alive = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch (_) {}
    };
  }, [router.isReady, redirectOnce]);

  async function hardLocalReset() {
    setErr("");
    setInfo("");
    setBusy(true);
    try {
      try {
        await supabase.auth.signOut();
      } catch (_) {}

      try {
        const keys = Object.keys(localStorage || {});
        keys
          .filter((k) => k.startsWith("sb-") || k.toLowerCase().includes("supabase"))
          .forEach((k) => localStorage.removeItem(k));
      } catch (_) {}

      try {
        const keys = Object.keys(sessionStorage || {});
        keys.forEach((k) => sessionStorage.removeItem(k));
      } catch (_) {}

      if ("serviceWorker" in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        } catch (_) {}
      }
      if (window.caches?.keys) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        } catch (_) {}
      }

      setInfo("Reset local terminé ✅ Recharge…");
      setTimeout(() => window.location.reload(), 600);
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setInfo("");

    const em = email.trim();
    const pw = password;

    if (!em) return setErr("Email requis.");
    if (!pw) return setErr("Mot de passe requis.");

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: em,
        password: pw,
      });

      if (error) {
        setErr(error.message || "Connexion refusée");
        return;
      }

      // on laisse onAuthStateChange faire la redirection (avec verrou)
      setInfo("Connecté ✅ Redirection…");
    } catch (e3) {
      setErr(e3?.message || String(e3));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md card space-y-4">
        <div className="hdr">Connexion</div>

        <div className="text-xs text-gray-600">
          Session:{" "}
          <b>
            {sessionInfo === "checking"
              ? "vérification…"
              : sessionInfo === "yes"
              ? "présente"
              : "aucune"}
          </b>{" "}
          • Redirige vers <code>{nextPath}</code>
        </div>

        {err ? (
          <div
            className="text-sm border rounded-xl p-2"
            style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}
          >
            {err}
          </div>
        ) : null}

        {info ? (
          <div
            className="text-sm border rounded-xl p-2"
            style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9", color: "#0f172a" }}
          >
            {info}
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <div className="text-sm mb-1">Email</div>
            <input
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="ex: olivia@bm.local"
            />
          </div>

          <div>
            <div className="text-sm mb-1">Mot de passe</div>
            <input
              className="input w-full"
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
            <label className="text-xs text-gray-600 inline-flex items-center gap-2 mt-2">
              <input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />
              Afficher le mot de passe
            </label>
          </div>

          <button className="btn w-full" disabled={busy}>
            {busy ? "Connexion…" : "Se connecter"}
          </button>
        </form>

        <div className="flex flex-col sm:flex-row gap-2">
          <button className="btn" onClick={() => (window.location.href = "/purge")} disabled={busy}>
            /purge
          </button>
          <button className="btn" onClick={() => (window.location.href = "/logout")} disabled={busy}>
            /logout
          </button>
          <button className="btn" onClick={hardLocalReset} disabled={busy}>
            Reset local
          </button>
        </div>

        <div className="text-xs text-gray-500">
          Si la connexion échoue, l’erreur Supabase sera affichée ici (clé invalide, credentials, projet, etc.).
        </div>
      </div>
    </div>
  );
}
