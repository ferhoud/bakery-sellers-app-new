// pages/admin/supervisors.js
// Admin-only: create/manage ONE supervisor account (Auth + profiles.role='supervisor').
// UX: read-only by default, button "Modifier" to enable fields, then "Enregistrer" appears.
// Notes:
// - Does NOT depend on useAuth (avoids infinite loading)
// - Email/password fields are protected against browser autofill

import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabaseClient";
import { isAdminEmail } from "@/lib/admin";

function safeStr(x) {
  return (x ?? "").toString();
}

function looksLikeEmail(email) {
  const e = safeStr(email).trim();
  return e.includes("@") && e.includes(".");
}

async function readJsonSafe(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null, text };
  } catch {
    return { ok: res.ok, status: res.status, data: null, text };
  }
}

export default function AdminSupervisorsPage() {
  const router = useRouter();

  const [phase, setPhase] = useState("boot"); // boot | denied | ready
  const [step, setStep] = useState("Init…");
  const [token, setToken] = useState("");
  const [adminEmail, setAdminEmail] = useState("");

  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null); // {type:'ok'|'err', text}

  const [supervisor, setSupervisor] = useState(null);
  const [editMode, setEditMode] = useState(false);

  const [createForm, setCreateForm] = useState({ full_name: "", email: "", password: "" });
  const [editForm, setEditForm] = useState({ full_name: "", active: true, email: "", password: "" });

  const baseline = useMemo(() => {
    if (!supervisor) return null;
    return {
      full_name: supervisor.full_name || "",
      active: !!supervisor.active,
    };
  }, [supervisor]);

  const canSave = useMemo(() => {
    if (!editMode) return false;
    if (!supervisor?.user_id) return false;

    const full_name = safeStr(editForm.full_name).trim();
    const active = !!editForm.active;
    const email = safeStr(editForm.email).trim().toLowerCase();
    const password = safeStr(editForm.password);

    if (!full_name) return false;
    if (email && !looksLikeEmail(email)) return false;
    if (password && password.length < 6) return false;

    // Avoid save if nothing changed
    const changedName = baseline ? full_name !== baseline.full_name : true;
    const changedActive = baseline ? active !== baseline.active : true;
    const changedCreds = !!email || !!password;

    return changedName || changedActive || changedCreds;
  }, [editMode, editForm, supervisor, baseline]);

  const loadSupervisor = useCallback(
    async (tkn) => {
      if (!tkn) return;
      setBusy(true);
      setBanner(null);
      setStep("Chargement superviseur…");

      const res = await fetch(`/api/admin/supervisor/get?ts=${Date.now()}`, {
        headers: { Authorization: `Bearer ${tkn}` },
        cache: "no-store",
      });
      const out = await readJsonSafe(res);

      setBusy(false);

      if (out.status === 401) {
        router.replace(`/login?next=${encodeURIComponent("/admin/supervisors")}`);
        return;
      }
      if (out.status === 403) {
        setPhase("denied");
        setBanner({ type: "err", text: "Accès refusé (admin uniquement)." });
        return;
      }
      if (!out.ok) {
        setSupervisor(null);
        setBanner({ type: "err", text: out.data?.error || out.text || "Erreur API superviseur/get" });
        setStep("Erreur");
        return;
      }

      const sup = out.data?.supervisor || null;
      setSupervisor(sup);

      // Reset edit state each reload
      setEditMode(false);

      if (sup) {
        setEditForm({
          full_name: sup.full_name || "",
          active: !!sup.active,
          email: "",
          password: "",
        });
      }

      setStep("OK");
    },
    [router]
  );

  useEffect(() => {
    let alive = true;

    async function boot() {
      try {
        setPhase("boot");
        setStep("Vérification session…");

        const { data } = await supabase.auth.getSession();
        const session = data?.session || null;

        if (!alive) return;

        if (!session) {
          router.replace(`/login?next=${encodeURIComponent("/admin/supervisors")}`);
          return;
        }

        const email = (session.user?.email || "").toLowerCase();
        setAdminEmail(session.user?.email || "");

        const tkn = session.access_token || "";
        setToken(tkn);

        if (!isAdminEmail(email)) {
          setPhase("denied");
          setStep("Accès refusé");
          return;
        }

        setPhase("ready");
        await loadSupervisor(tkn);
      } catch (e) {
        if (!alive) return;
        setPhase("ready");
        setBanner({ type: "err", text: e?.message || "Erreur boot superviseur" });
        setStep("Erreur");
      }
    }

    boot();

    return () => {
      alive = false;
    };
  }, [router, loadSupervisor]);

  async function apiPost(path, body) {
    const res = await fetch(`${path}?ts=${Date.now()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(body || {}),
    });
    return readJsonSafe(res);
  }

  const onCreate = async () => {
    setBanner(null);

    const full_name = safeStr(createForm.full_name).trim();
    const email = safeStr(createForm.email).trim().toLowerCase();
    const password = safeStr(createForm.password);

    if (!full_name) return setBanner({ type: "err", text: "Nom requis." });
    if (!looksLikeEmail(email)) return setBanner({ type: "err", text: "Email invalide." });
    if (password.length < 6) return setBanner({ type: "err", text: "Mot de passe: 6 caractères minimum." });

    setBusy(true);
    setStep("Création superviseur…");

    const out = await apiPost("/api/admin/supervisor/create", { full_name, email, password });

    setBusy(false);

    if (!out.ok) {
      setBanner({ type: "err", text: out.data?.error || out.text || "Erreur création superviseur" });
      setStep("Erreur");
      return;
    }

    setBanner({ type: "ok", text: "Superviseur créé." });
    setCreateForm({ full_name: "", email: "", password: "" });
    setStep("OK");

    await loadSupervisor(token);
  };

  const onEnterEdit = () => {
    setBanner(null);
    setEditMode(true);
  };

  const onCancelEdit = () => {
    setBanner(null);
    setEditMode(false);
    if (supervisor) {
      setEditForm({
        full_name: supervisor.full_name || "",
        active: !!supervisor.active,
        email: "",
        password: "",
      });
    }
  };

  const onSave = async () => {
    if (!supervisor?.user_id) return;
    if (!canSave) return;

    setBanner(null);

    const full_name = safeStr(editForm.full_name).trim();
    const active = !!editForm.active;
    const email = safeStr(editForm.email).trim().toLowerCase();
    const password = safeStr(editForm.password);

    setBusy(true);
    setStep("Mise à jour superviseur…");

    const out = await apiPost("/api/admin/supervisor/update", {
      supervisor_id: supervisor.user_id,
      full_name,
      active,
      email: email || null,
      password: password || null,
    });

    setBusy(false);

    if (!out.ok) {
      setBanner({ type: "err", text: out.data?.error || out.text || "Erreur mise à jour superviseur" });
      setStep("Erreur");
      return;
    }

    setBanner({ type: "ok", text: "Modifications enregistrées." });
    setStep("OK");

    await loadSupervisor(token);
  };

  if (phase === "boot") {
    return (
      <div className="p-4 max-w-5xl mx-auto">
        <div className="card">
          <div className="hdr">Superviseur (gestion)</div>
          <div className="text-sm text-gray-700 mt-2">Chargement…</div>
          <div className="text-xs text-gray-500 mt-1">{step}</div>
        </div>
      </div>
    );
  }

  if (phase === "denied") {
    return (
      <div className="p-4 max-w-5xl mx-auto">
        <div className="card">
          <div className="hdr">Accès refusé</div>
          <div className="mt-2 text-sm text-gray-700">Cette page est réservée aux admins.</div>
          <div className="mt-4">
            <Link href="/admin" className="btn">
              Retour admin
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Admin • Superviseur</title>
      </Head>

      <div className="p-4 max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="hdr">Superviseur (gestion)</div>
            <div className="text-xs text-gray-600">Admin: {adminEmail || "?"}</div>
            <div className="text-xs text-gray-500">État: {step}</div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/admin" className="btn">
              Retour Admin
            </Link>
            <button className="btn" onClick={() => loadSupervisor(token)} disabled={busy || !token}>
              Recharger
            </button>
          </div>
        </div>

        {banner ? (
          <div className={`card ${banner.type === "err" ? "border-red-300" : "border-green-300"}`}>
            <div className={banner.type === "err" ? "text-red-700" : "text-green-700"}>{banner.text}</div>
          </div>
        ) : null}

        {!supervisor ? (
          <div className="card space-y-3">
            <div className="hdr">Créer le superviseur (une seule fois)</div>

            {/* anti-autofill: names + autoComplete */}
            <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="grid sm:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-gray-600 mb-1">Nom</div>
                <input
                  className="input w-full"
                  name="sup_create_full_name"
                  autoComplete="off"
                  value={createForm.full_name}
                  onChange={(e) => setCreateForm((s) => ({ ...s, full_name: e.target.value }))}
                  placeholder="Ex: Superviseur"
                />
              </div>
              <div>
                <div className="text-xs text-gray-600 mb-1">Email</div>
                <input
                  className="input w-full"
                  name="sup_create_email"
                  autoComplete="new-email"
                  inputMode="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm((s) => ({ ...s, email: e.target.value }))}
                  placeholder="superviseur@bm.local"
                />
              </div>
              <div>
                <div className="text-xs text-gray-600 mb-1">Mot de passe</div>
                <input
                  className="input w-full"
                  name="sup_create_password"
                  autoComplete="new-password"
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm((s) => ({ ...s, password: e.target.value }))}
                  placeholder="******"
                />
              </div>
            </form>

            <button className="btn" onClick={onCreate} disabled={busy || !token}>
              Créer
            </button>

            <div className="text-xs text-gray-600">
              Après création, la tablette utilise seulement <span className="font-mono">/supervisor</span>.
            </div>
          </div>
        ) : (
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <div className="hdr">Superviseur actuel</div>
              {!editMode ? (
                <button className="btn" onClick={onEnterEdit} disabled={busy}>
                  Modifier
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    className={`btn ${canSave ? "" : "opacity-50"}`}
                    style={
                      canSave
                        ? {
                            background: "#16a34a", // green
                            borderColor: "#16a34a",
                          }
                        : undefined
                    }
                    onClick={onSave}
                    disabled={!canSave || busy}
                  >
                    Enregistrer
                  </button>
                  <button className="btn" onClick={onCancelEdit} disabled={busy}>
                    Annuler
                  </button>
                </div>
              )}
            </div>

            <div className="text-sm text-gray-700">
              <div>
                <span className="font-semibold">Email:</span> {supervisor.email || "(inconnu)"}
              </div>
              <div>
                <span className="font-semibold">État:</span> {supervisor.active ? "Actif" : "Inactif"}
              </div>
            </div>

            <div className="grid sm:grid-cols-4 gap-3">
              <div className="sm:col-span-2">
                <div className="text-xs text-gray-600 mb-1">Nom</div>
                <input
                  className="input w-full"
                  disabled={!editMode}
                  value={editForm.full_name}
                  onChange={(e) => setEditForm((s) => ({ ...s, full_name: e.target.value }))}
                />
              </div>

              <div>
                <div className="text-xs text-gray-600 mb-1">Actif</div>
                <select
                  className="input w-full"
                  disabled={!editMode}
                  value={editForm.active ? "1" : "0"}
                  onChange={(e) => setEditForm((s) => ({ ...s, active: e.target.value === "1" }))}
                >
                  <option value="1">Oui</option>
                  <option value="0">Non</option>
                </select>
              </div>

              <div>
                <div className="text-xs text-gray-600 mb-1">Nouveau mot de passe</div>
                <input
                  className="input w-full"
                  disabled={!editMode}
                  name="sup_edit_password"
                  autoComplete="new-password"
                  type="password"
                  value={editForm.password}
                  onChange={(e) => setEditForm((s) => ({ ...s, password: e.target.value }))}
                  placeholder="Laisser vide si inchangé"
                />
              </div>

              <div className="sm:col-span-2">
                <div className="text-xs text-gray-600 mb-1">Nouvel email</div>
                <input
                  className="input w-full"
                  disabled={!editMode}
                  name="sup_edit_email"
                  autoComplete="off"
                  inputMode="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm((s) => ({ ...s, email: e.target.value }))}
                  placeholder="Laisser vide si inchangé"
                />
              </div>
            </div>

            <div className="text-xs text-gray-600">
              Ici tu gères le compte superviseur (email/mdp) et son statut. La tablette, elle, utilise seulement <span className="font-mono">/supervisor</span>.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
