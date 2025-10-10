
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
    } finally {
      setBusy(false);
    }
  };

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
    </div>
  );
}
