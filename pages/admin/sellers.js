// pages/admin/sellers.js
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

export default function AdminSellers() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]); // [{user_id, full_name, email, active}]
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ full_name: "", identifier: "", email: "", password: "" });
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState({ full_name: "", email: "" });

  // sécurité
  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace("/login"); return; }
    if (!profile) return;
    if (profile.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  // charger vendeuses (depuis profiles) + emails (via vue/materialisée si dispo sinon champ email nullable)
  const load = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, full_name, role, active, email")
      .eq("role", "seller")
      .order("full_name", { ascending: true });

    if (error) { console.error(error); setRows([]); return; }
    setRows((data || []).map(r => ({ ...r, email: r.email || "" })));
  };

  useEffect(() => { if (session) load(); }, [session]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const k = q.toLowerCase();
    return rows.filter(r =>
      (r.full_name || "").toLowerCase().includes(k) ||
      (r.email || "").toLowerCase().includes(k) ||
      (r.user_id || "").toLowerCase().includes(k)
    );
  }, [rows, q]);

  /* ---------- Actions ---------- */
  const onCreate = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const resp = await fetch("/api/admin/users/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "create failed");
      setCreating(false);
      setForm({ full_name: "", identifier: "", email: "", password: "" });
      await load();
    } catch (e) {
      alert("Création impossible: " + e.message);
    } finally { setBusy(false); }
  };

  const startEdit = (r) => {
    setEditId(r.user_id);
    setEdit({ full_name: r.full_name || "", email: r.email || "" });
  };
  const cancelEdit = () => { setEditId(null); setEdit({ full_name: "", email: "" }); };

  const saveEdit = async (id) => {
    setBusy(true);
    try {
      const resp = await fetch("/api/admin/users/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: id, ...edit }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "update failed");
      setEditId(null);
      await load();
    } catch (e) {
      alert("Modification impossible: " + e.message);
    } finally { setBusy(false); }
  };

  const deactivate = async (r) => {
    if (!confirm(`Désactiver ${r.full_name} ?\n(Conserve l’historique, retire de la liste et bloque l’accès)`)) return;
    setBusy(true);
    try {
      const resp = await fetch("/api/admin/users/deactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: r.user_id }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "deactivate failed");
      await load();
    } catch (e) {
      alert("Désactivation impossible: " + e.message);
    } finally { setBusy(false); }
  };

  const hardDelete = async (r) => {
    if (!confirm(`SUPPRIMER DÉFINITIVEMENT ${r.full_name} ?\n(Historique effacé irrémédiablement)`)) return;
    setBusy(true);
    try {
      const resp = await fetch("/api/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: r.user_id }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "delete failed");
      await load();
    } catch (e) {
      alert("Suppression impossible: " + e.message);
    } finally { setBusy(false); }
  };

  if (loading || !session || !profile) {
    return <div className="p-4">Chargement…</div>;
  }

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6">
      {/* Header avec bouton retour (à gauche) */}
      <div className="flex items-center justify-between">
        <Link href="/admin" className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border hover:shadow-sm transition">
          <span>←</span>
          <span className="font-medium">Retour Admin</span>
        </Link>
        <div className="text-sm text-gray-500">Gérer les vendeuses</div>
      </div>

      {/* Barre d’outils */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="relative w-full md:w-96">
          <input
            type="text"
            className="input w-full"
            placeholder="Rechercher par nom, email, ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button className="btn" onClick={() => setCreating(true)}>+ Ajouter une vendeuse</button>
      </div>

      {/* Liste des vendeuses */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse.</div>
        ) : (
          filtered.map((r) => (
            <div key={r.user_id} className="border rounded-2xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              {/* Col gauche */}
              <div className="min-w-0">
                {editId === r.user_id ? (
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input className="input" placeholder="Nom complet" value={edit.full_name} onChange={(e)=>setEdit(p=>({...p,full_name:e.target.value}))}/>
                    <input className="input" placeholder="Email de connexion" value={edit.email} onChange={(e)=>setEdit(p=>({...p,email:e.target.value}))}/>
                  </div>
                ) : (
                  <>
                    <div className="font-medium truncate">{r.full_name || "—"}</div>
                    <div className="text-xs text-gray-600 break-all">{r.email || "—"}</div>
                    <div className="text-xs text-gray-400 mt-0.5">ID: {r.user_id}</div>
                  </>
                )}
              </div>

              {/* Col droit (actions) */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-1 rounded-full ${r.active ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                  {r.active ? "Active" : "Inactive"}
                </span>

                {editId === r.user_id ? (
                  <>
                    <button className="btn" disabled={busy} onClick={()=>saveEdit(r.user_id)}>Enregistrer</button>
                    <button className="btn" onClick={cancelEdit}>Annuler</button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={()=>startEdit(r)}>Modifier</button>
                    <button className="btn" onClick={()=>deactivate(r)} style={{background:"#f59e0b",color:"#fff",borderColor:"transparent"}}>Désactiver</button>
                    <button className="btn" onClick={()=>hardDelete(r)} style={{background:"#dc2626",color:"#fff",borderColor:"transparent"}}>Supprimer</button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal création */}
      {creating && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-4 w-full max-w-lg space-y-3">
            <div className="text-lg font-semibold">Ajouter une vendeuse</div>
            <form className="space-y-3" onSubmit={onCreate}>
              <div>
                <div className="text-sm mb-1">Nom complet</div>
                <input className="input w-full" required value={form.full_name} onChange={(e)=>setForm(p=>({...p,full_name:e.target.value}))}/>
              </div>
              <div>
                <div className="text-sm mb-1">Identifiant (libre, optionnel)</div>
                <input className="input w-full" value={form.identifier} onChange={(e)=>setForm(p=>({...p,identifier:e.target.value}))}/>
              </div>
              <div>
                <div className="text-sm mb-1">Mail de connexion</div>
                <input className="input w-full" type="email" required value={form.email} onChange={(e)=>setForm(p=>({...p,email:e.target.value}))}/>
              </div>
              <div>
                <div className="text-sm mb-1">Mot de passe</div>
                <input className="input w-full" type="password" required value={form.password} onChange={(e)=>setForm(p=>({...p,password:e.target.value}))}/>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button type="button" className="btn" onClick={()=>setCreating(false)}>Annuler</button>
                <button type="submit" className="btn" disabled={busy} style={{background:"#2563eb",color:"#fff",borderColor:"transparent"}}>Créer</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
