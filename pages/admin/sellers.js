<<<<<<< HEAD
// pages/admin/sellers.js
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../../lib/useAuth";

const API_CREATE = "/api/admin/create-seller";
const API_LIST   = "/api/admin/list-sellers";

/* Icônes SVG stables (pas de polices externes) */
const PencilIcon = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" stroke="currentColor" strokeWidth="1.5" fill="currentColor"/>
    <path d="M20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z" fill="currentColor"/>
  </svg>
);
const TrashIcon = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M6 7h12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M8 7v12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V7" stroke="currentColor" strokeWidth="1.5"/>
  </svg>
);

/* Appels API */
async function createSellerAPI({ full_name, email, password }) {
  const r = await fetch(API_CREATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name, email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Création échouée");
  return j;
}

export default function SellersAdminPage() {
  const { session, profile, loading } = useAuth();
  const router = useRouter();

  /* Liste */
  const [sellers, setSellers] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  /* Formulaire */
  const [full_name, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  /* Garde d'authentification */
  useEffect(() => {
    if (loading) return;
    if (!session) router.replace("/login");
    if (profile && profile.role !== "admin") router.replace("/app");
  }, [session, profile, loading, router]);

  /* Récupérer la liste via l'API serveur (service-role) */
  const loadSellers = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch(API_LIST, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Échec chargement vendeuses");
      setSellers(json.sellers || []);
    } catch (e) {
      setListError(e.message || "Erreur");
      setSellers([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { loadSellers(); }, [loadSellers]);

  /* Créer une vendeuse puis rafraîchir la liste */
  const onSubmit = async (e) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await createSellerAPI({ full_name, email, password });
      setMsg("Vendeuse créée !");
      setFullName(""); setEmail(""); setPassword("");
      await loadSellers();
    } catch (err) {
      setMsg(err?.message ?? "Erreur");
=======

// touch: 2025-10-10 v-sellers-inline-edit + graceful-active-flag

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

function Chip({ children }) {
  return (
    <span
      className="inline-block text-xs px-2 py-1 rounded-full"
      style={{ background: "#e5e7eb", color: "#111827" }}
    >
      {children}
    </span>
  );
}

export default function SellersAdmin() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [list, setList] = useState([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("all"); // all | active | inactive
  const [busy, setBusy] = useState(false);

  /* Guards */
  useEffect(() => {
    if (loading) return;
    if (!session) r.replace("/login");
    if (profile && profile.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("list_sellers");
    if (error) console.error("list_sellers error:", error);
    // Try to fetch flags/colors if present in profiles
    if (data?.length) {
      const ids = data.map(d => d.user_id);
      const { data: profs } = await supabase
        .from("profiles")
        .select("user_id, is_active, color")
        .in("user_id", ids);
      const map = {};
      (profs || []).forEach(p => { map[p.user_id] = p; });
      setList(data.map(d => ({
        ...d,
        is_active: map[d.user_id]?.is_active ?? true,
        color: map[d.user_id]?.color ?? null,
        _edit: false,
        _name: d.full_name,
      })));
    } else {
      setList([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (filter === "active") return list.filter(i => i.is_active !== false);
    if (filter === "inactive") return list.filter(i => i.is_active === false);
    return list;
  }, [list, filter]);

  /* Actions */
  const createSeller = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      // Prefer existing API route if present
      const res = await fetch("/api/admin/create-seller", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: name }),
      });
      if (!res.ok) {
        // Fallback: try insert minimal profile (may fail if RLS)
        const { error } = await supabase
          .from("profiles")
          .insert({ full_name: name, role: "seller" });
        if (error) throw error;
      }
      setNewName("");
      await load();
    } catch (e) {
      console.error(e);
      alert("Impossible de créer la vendeuse (API/RLS).");
    } finally {
      setCreating(false);
    }
  }, [newName, load]);

  const beginEdit = (id) => {
    setList(prev => prev.map(it => it.user_id === id ? { ...it, _edit: true, _name: it.full_name } : it));
  };
  const cancelEdit = (id) => {
    setList(prev => prev.map(it => it.user_id === id ? { ...it, _edit: false, _name: it.full_name } : it));
  };
  const saveName = async (id) => {
    const row = list.find(i => i.user_id === id);
    const name = (row?._name || "").trim();
    if (!name) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: name })
        .eq("user_id", id);
      if (error) throw error;
      setList(prev => prev.map(it => it.user_id === id ? { ...it, full_name: name, _edit: false } : it));
    } catch (e) {
      console.error(e);
      alert("Échec de la mise à jour du nom (RLS ?).");
>>>>>>> deploy-sellers
    } finally {
      setBusy(false);
    }
  };

<<<<<<< HEAD
  /* Placeholders d’actions (à brancher si besoin) */
  const onRename = (s) => console.log("Renommer", s);
  const onDeactivate = (s) => console.log("Désactiver", s);
  const onHardDelete = (s) => console.log("Supprimer hard", s);

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-6">
      {/* --- Topbar avec bouton demandé --- */}
      <div className="flex items-center justify-between mb-4">
        <button className="btn" onClick={() => router.push("/admin")}>
          Retour admin
        </button>
        <a className="btn" href="/logout">Se déconnecter</a>
      </div>

      <div className="hdr">Gérer les vendeuses</div>

      {/* --- LISTE EN HAUT --- */}
      <div className="card">
        <div className="hdr mb-2">Vendeuses existantes</div>

        {listLoading ? (
          <div className="text-sm text-gray-600">Chargement…</div>
        ) : listError ? (
          <div className="text-sm text-red-600">Erreur : {listError}</div>
        ) : sellers.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div>
        ) : (
          <ul className="space-y-2">
            {sellers.map((s) => (
              <li
                key={s.user_id || s.id}
                className="border rounded-2xl p-3 bg-white flex items-center justify-between"
              >
                <div>
                  <div className="font-medium">{s.full_name || "—"}</div>
                  <div className="text-sm text-gray-600">{s.user_id || s.id}</div>
                </div>

                <div className="flex items-center gap-2">
                  <button className="btn" onClick={() => onRename(s)}>
                    <PencilIcon style={{ marginRight: 8 }} /> Modifier
                  </button>
                  <button
                    className="btn"
                    style={{ background: "#dc2626" }}
                    onClick={() => onDeactivate(s)}
                  >
                    Désactiver
                  </button>
                  <button
                    className="btn"
                    style={{ background: "#78350f" }}
                    onClick={() => onHardDelete(s)}
                  >
                    <TrashIcon style={{ marginRight: 8 }} /> Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- FORMULAIRE EN BAS --- */}
      <form onSubmit={onSubmit} className="space-y-3 border rounded-2xl p-4 bg-white">
        <div className="hdr mb-2">Ajouter une vendeuse</div>

        <div>
          <label className="block text-sm mb-1">Nom complet</label>
          <input
            className="input w-full"
            value={full_name}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="block text-sm mb-1">Email</label>
          <input
            className="input w-full"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="vendeuse@vendeuses.local"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">Mot de passe</label>
          <input
            className="input w-full"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Création..." : "Créer la vendeuse"}
        </button>
        {msg && <div className="text-sm mt-2">{msg}</div>}
      </form>
=======
  const toggleActive = async (id, nextVal) => {
    setBusy(true);
    try {
      // Try to update profiles.is_active if exists
      const { error } = await supabase
        .from("profiles")
        .update({ is_active: nextVal })
        .eq("user_id", id);
      if (error) throw error;
      setList(prev => prev.map(it => it.user_id === id ? { ...it, is_active: nextVal } : it));
    } catch (e) {
      console.warn("toggleActive failed:", e?.message || e);
      alert("Impossible de changer l'état actif (colonne manquante / RLS).");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Gestion des vendeuses</div>
        <Link href="/admin" legacyBehavior><a className="btn">⬅ Retour admin</a></Link>
      </div>

      {/* Ajout */}
      <div className="card">
        <div className="hdr mb-2">Ajouter une vendeuse</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="input flex-1"
            placeholder="Nom et prénom"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="btn" onClick={createSeller} disabled={creating || !newName.trim()}>
            {creating ? "Création…" : "Ajouter"}
          </button>
        </div>
        <div className="text-xs text-gray-500 mt-2">
          Astuce : l’API <code>/api/admin/create-seller</code> est utilisée si disponible, sinon essai direct en base.
        </div>
      </div>

      {/* Liste */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <div className="hdr">Vendeuses enregistrées</div>
          <div className="flex items-center gap-2">
            <label className="text-sm">Filtrer:</label>
            <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">Toutes</option>
              <option value="active">Actives</option>
              <option value="inactive">Inactives</option>
            </select>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-3">Nom</th>
                  <th className="py-2 pr-3">ID</th>
                  <th className="py-2 pr-3">Statut</th>
                  <th className="py-2 pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.user_id} className="border-b">
                    <td className="py-2 pr-3">
                      {!s._edit ? (
                        <div className="flex items-center gap-2">
                          <Chip>{s.full_name}</Chip>
                          <button className="text-blue-600 underline" onClick={() => beginEdit(s.user_id)}>modifier</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            className="input"
                            value={s._name}
                            onChange={(e) => {
                              const v = e.target.value;
                              setList(prev => prev.map(it => it.user_id === s.user_id ? { ...it, _name: v } : it));
                            }}
                          />
                          <button className="btn" onClick={() => saveName(s.user_id)} disabled={busy || !s._name.trim()}>Enregistrer</button>
                          <button className="btn" onClick={() => cancelEdit(s.user_id)}>Annuler</button>
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">{s.user_id}</td>
                    <td className="py-2 pr-3">
                      <span className={`text-xs px-2 py-1 rounded-full text-white ${s.is_active === false ? "bg-gray-400" : "bg-green-600"}`}>
                        {s.is_active === false ? "inactif" : "actif"}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <button
                          className="btn"
                          onClick={() => toggleActive(s.user_id, !(s.is_active !== false))}
                          disabled={busy}
                        >
                          {s.is_active === false ? "Activer" : "Désactiver"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
>>>>>>> deploy-sellers
    </div>
  );
}
