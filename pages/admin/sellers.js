// pages/admin/sellers.js
/* Admin – gestion des vendeuses (nom + actif + email + mot de passe + blocage + suppression)

   ✅ Ne dépend PAS de useAuth.loading (qui peut rester bloqué dans certains cas)
   ✅ Récupère le JWT via supabase.auth.getSession()

   Routes API (service role) attendues :
     - GET  /api/admin/sellers/list
     - POST /api/admin/sellers/create
     - POST /api/admin/sellers/update
     - POST /api/admin/sellers/delete
*/

import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabaseClient";

function safeStr(x) {
  return (x ?? "").toString();
}

function isValidEmail(email) {
  const e = safeStr(email).trim();
  return e.includes("@") && e.includes(".");
}

async function getAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

export default function AdminSellersPage() {
  const r = useRouter();
  const nextUrl = "/admin/sellers";

  const [phase, setPhase] = useState("boot"); // boot | loading | ok | denied | error | no_session
  const [errMsg, setErrMsg] = useState("");
  const [sessionEmail, setSessionEmail] = useState("");

  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState({});
  const [globalBusy, setGlobalBusy] = useState(false);

  // Create seller
  const [createFullName, setCreateFullName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  const load = useCallback(async () => {
    setErrMsg("");
    setPhase("loading");

    let token = null;
    try {
      token = await getAccessToken();
    } catch {
      token = null;
    }

    if (!token) {
      setPhase("no_session");
      r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
      return;
    }

    try {
      const res = await fetch("/api/admin/sellers/list", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const txt = await res.text();
      let data = null;
      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(
          "Réponse non-JSON (route API manquante/404 ou HTML). Début: " + txt.slice(0, 120)
        );
      }

      if (res.status === 401) {
        setPhase("no_session");
        r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }
      if (res.status === 403) {
        setPhase("denied");
        return;
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Erreur (${res.status})`);
      }

      const sellers = data.sellers || [];
      setRows(sellers);

      const nextDraft = {};
      for (const s of sellers) {
        nextDraft[s.user_id] = {
          full_name: safeStr(s.full_name),
          active: !!s.active,
          email: safeStr(s.email),
          newPassword: "",
        };
      }
      setDraft(nextDraft);
      setPhase("ok");
    } catch (e) {
      setErrMsg(e?.message || "Erreur lors du chargement.");
      setPhase("error");
    }
  }, [r]);

  // Boot: ne jamais rester bloqué sur "Chargement".
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const sess = data?.session || null;
        if (!alive) return;
        if (!sess) {
          setPhase("no_session");
          r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
          return;
        }
        setSessionEmail(sess.user?.email || "");
        load();
      } catch {
        if (!alive) return;
        setPhase("no_session");
        r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (!alive) return;
      setSessionEmail(sess?.user?.email || "");
      if (!sess) setPhase("no_session");
    });

    return () => {
      alive = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, [r, load]);

  const headerRight = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <Link href="/admin" className="btn">
          ← Retour admin
        </Link>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setGlobalBusy(true);
            load().finally(() => setGlobalBusy(false));
          }}
          disabled={globalBusy}
          title="Rafraîchir"
        >
          ⟳ Rafraîchir
        </button>
        <Link href="/logout" className="btn">
          Se déconnecter
        </Link>
      </div>
    ),
    [globalBusy, load]
  );

  const onChange = (user_id, patch) => {
    setDraft((prev) => ({
      ...prev,
      [user_id]: { ...(prev[user_id] || {}), ...patch },
    }));
  };

  const saveOne = async (user_id, opts = {}) => {
    setBusy((p) => ({ ...p, [user_id]: true }));
    setErrMsg("");

    try {
      const token = await getAccessToken();
      if (!token) {
        setPhase("no_session");
        r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      const d = draft[user_id] || {};
      const payload = {
        user_id,
        full_name: safeStr(d.full_name).trim(),
        active: !!d.active,
        email: safeStr(d.email).trim(),
        password: safeStr(d.newPassword),
        disable: !!opts.disable,
        hard_delete: !!opts.hard_delete,
      };

      if (payload.email && !isValidEmail(payload.email)) {
        throw new Error("Email invalide.");
      }
      if (payload.password && payload.password.length < 6) {
        throw new Error("Mot de passe trop court (min 6 caractères)." );
      }

      const url = opts.hard_delete ? "/api/admin/sellers/delete" : "/api/admin/sellers/update";
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const txt = await res.text();
      let data = null;
      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(
          "Réponse non-JSON (route API manquante/404 ou HTML). Début: " + txt.slice(0, 120)
        );
      }

      if (res.status === 401) {
        setPhase("no_session");
        r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }
      if (res.status === 403) {
        setPhase("denied");
        return;
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Erreur (${res.status})`);
      }

      // reset password field after successful update
      setDraft((prev) => ({
        ...prev,
        [user_id]: { ...(prev[user_id] || {}), newPassword: "" },
      }));

      await load();
    } catch (e) {
      setErrMsg(e?.message || "Erreur lors de la sauvegarde.");
    } finally {
      setBusy((p) => ({ ...p, [user_id]: false }));
    }
  };

  const hardDelete = async (user_id) => {
    const ok = window.prompt('Pour supprimer définitivement ce compte, tape "SUPPRIMER"') === "SUPPRIMER";
    if (!ok) return;
    await saveOne(user_id, { hard_delete: true });
  };

  const disableAccess = async (user_id) => {
    const ok = window.confirm("Bloquer l'accès ? (Active=false + mot de passe aléatoire)");
    if (!ok) return;
    await saveOne(user_id, { disable: true });
  };

  const createSeller = async () => {
    setErrMsg("");
    setCreateMsg("");
    const email = safeStr(createEmail).trim();
    const password = safeStr(createPassword);
    const full_name = safeStr(createFullName).trim();

    if (!full_name) {
      setCreateMsg("Nom obligatoire.");
      return;
    }
    if (!email || !isValidEmail(email)) {
      setCreateMsg("Email invalide.");
      return;
    }
    if (!password || password.length < 6) {
      setCreateMsg("Mot de passe trop court (min 6 caractères).");
      return;
    }

    setCreateBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        setPhase("no_session");
        r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      const res = await fetch("/api/admin/sellers/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email, password, full_name }),
      });

      const txt = await res.text();
      let data = null;
      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(
          "Réponse non-JSON (route API manquante/404 ou HTML). Début: " + txt.slice(0, 120)
        );
      }

      if (res.status === 401) {
        setPhase("no_session");
        r.replace(`/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }
      if (res.status === 403) {
        setPhase("denied");
        return;
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Erreur (${res.status})`);
      }

      setCreateMsg("✅ Vendeuse créée.");
      setCreateFullName("");
      setCreateEmail("");
      setCreatePassword("");
      await load();
    } catch (e) {
      setCreateMsg(e?.message || "Erreur lors de la création.");
    } finally {
      setCreateBusy(false);
    }
  };

  return (
    <>
      <Head>
        <title>Vendeuses – gestion</title>
      </Head>

      <div className="p-4 max-w-7xl 2xl:max-w-screen-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="hdr">
            Vendeuses <span className="sub">(gestion)</span>
          </div>
          {headerRight}
        </div>

        {phase === "boot" || phase === "loading" ? (
          <div className="card">
            <div className="text-sm text-gray-600">Chargement…</div>
            {sessionEmail ? (
              <div className="text-xs text-gray-500" style={{ marginTop: 8 }}>
                Session: {sessionEmail}
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "no_session" ? (
          <div className="card">
            <div className="hdr mb-2">Session manquante</div>
            <div className="text-sm">Redirection vers la connexion…</div>
          </div>
        ) : null}

        {phase === "denied" ? (
          <div className="card">
            <div className="hdr mb-2">Accès refusé</div>
            <div className="text-sm">Cette page est réservée aux admins.</div>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="card">
            <div className="hdr mb-2">Erreur</div>
            <div className="text-sm">{errMsg || "Une erreur est survenue."}</div>
            <div style={{ height: 10 }} />
            <button type="button" className="btn" onClick={load}>
              Réessayer
            </button>
          </div>
        ) : null}

        {errMsg && phase === "ok" ? (
          <div className="card" style={{ borderColor: "#fecaca", background: "#fff7ed" }}>
            <div className="text-sm">{errMsg}</div>
          </div>
        ) : null}

        {phase === "ok" ? (
          <>
          <div className="card">
            <div className="text-sm text-gray-600">
              Tu peux modifier : <b>nom</b>, <b>actif</b>, <b>email</b>, <b>mot de passe</b>.
              <br />
              Conseil : <b>Bloquer l’accès</b> plutôt que supprimer (ça garde l’historique planning).
            </div>

            <div style={{ height: 12 }} />

            <div className="space-y-3">
              {rows.map((s) => {
                const d = draft[s.user_id] || {};
                const b = !!busy[s.user_id];

                return (
                  <div key={s.user_id} className="card" style={{ padding: 14 }}>
                    <div className="text-xs text-gray-500">ID: {s.user_id}</div>

                    <div style={{ height: 10 }} />

                    <div className="grid" style={{ gap: 10, gridTemplateColumns: "2fr 2fr 1fr" }}>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Nom</div>
                        <input
                          className="input"
                          value={safeStr(d.full_name)}
                          onChange={(e) => onChange(s.user_id, { full_name: e.target.value })}
                          placeholder="Nom"
                        />
                      </div>

                      <div>
                        <div className="text-xs text-gray-500 mb-1">Email de connexion</div>
                        <input
                          className="input"
                          value={safeStr(d.email)}
                          onChange={(e) => onChange(s.user_id, { email: e.target.value })}
                          placeholder="email@exemple.com"
                        />
                      </div>

                      <div className="flex items-end justify-end gap-2">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => onChange(s.user_id, { active: !d.active })}
                          disabled={b}
                          title="Activer/Désactiver"
                        >
                          {d.active ? "Active ✅" : "Inactive ⛔"}
                        </button>
                      </div>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="grid" style={{ gap: 10, gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Nouveau mot de passe (optionnel)</div>
                        <input
                          className="input"
                          type="password"
                          value={safeStr(d.newPassword)}
                          onChange={(e) => onChange(s.user_id, { newPassword: e.target.value })}
                          placeholder="••••••"
                        />
                      </div>

                      <div className="flex items-end">
                        <button type="button" className="btn" disabled={b} onClick={() => saveOne(s.user_id)}>
                          Enregistrer
                        </button>
                      </div>

                      <div className="flex items-end">
                        <button type="button" className="btn" disabled={b} onClick={() => disableAccess(s.user_id)}>
                          Bloquer accès
                        </button>
                      </div>

                      <div className="flex items-end justify-end">
                        <button
                          type="button"
                          className="btn"
                          disabled={b}
                          onClick={() => hardDelete(s.user_id)}
                          title="Supprime le compte Auth + désactive le profil. À utiliser rarement."
                        >
                          Supprimer
                        </button>
                      </div>
                    </div>

                    <div style={{ height: 6 }} />

                    <div className="text-xs text-gray-500">
                      Rôle: <b>{safeStr(s.role || "seller")}</b>
                      {s.last_sign_in_at ? (
                        <>
                          {" "}• Dernière connexion: <b>{new Date(s.last_sign_in_at).toLocaleString()}</b>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

          </div>

          <div className="card">
            <div className="hdr mb-2">Ajouter une vendeuse</div>
            <div className="text-sm text-gray-600">
              Cela crée le compte dans <b>Supabase Auth</b> + un profil dans <b>profiles</b>.
              (Email confirmé automatiquement pour pouvoir se connecter tout de suite.)
            </div>

            <div style={{ height: 12 }} />

            <div className="grid" style={{ gap: 10, gridTemplateColumns: "2fr 2fr 1fr" }}>
              <div>
                <div className="text-xs text-gray-500 mb-1">Nom</div>
                <input
                  className="input"
                  value={createFullName}
                  onChange={(e) => setCreateFullName(e.target.value)}
                  placeholder="Ex: Sarah"
                />
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">Email de connexion</div>
                <input
                  className="input"
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  placeholder="sarah@bm.local"
                />
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">Mot de passe</div>
                <input
                  className="input"
                  type="password"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  placeholder="min 6 caractères"
                />
              </div>
            </div>

            <div style={{ height: 10 }} />

            <div className="flex items-center justify-between gap-2">
              <div className="text-sm" style={{ color: createMsg.startsWith("✅") ? "#065f46" : "#92400e" }}>
                {createMsg}
              </div>

              <button
                type="button"
                className="btn"
                onClick={createSeller}
                disabled={createBusy}
              >
                {createBusy ? "Création…" : "Ajouter"}
              </button>
            </div>
          </div>
          </>
        ) : null}
      </div>
    </>
  );
}
