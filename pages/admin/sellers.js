// pages/admin/sellers.js
import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

/**
 * Hypothèses de schéma Supabase (recommandé)
 *
 * create table if not exists public.sellers (
 *   id uuid primary key default gen_random_uuid(),
 *   full_name text not null,
 *   is_active boolean not null default true,
 *   created_at timestamptz not null default now()
 * );
 *
 * -- RLS (si activé) : seul admin peut modifier
 * -- Exemple de politique :
 * -- create policy "sellers_read_admin" on sellers for select using ( auth.jwt() ->> 'role' = 'admin' );
 * -- create policy "sellers_write_admin" on sellers for all using ( auth.jwt() ->> 'role' = 'admin' );
 *
 * NOTE : Ton `admin.js` utilise supabase.rpc("list_sellers"). Assure-toi que l’RPC renvoie uniquement les vendeuses actives
 * et mappe les colonnes en { user_id: id, full_name } si tu veux conserver la même forme.
 * Exemple d’RPC côté DB (optionnel si tu préfères .from("sellers")) :
 *
 * create or replace function public.list_sellers()
 * returns table (user_id uuid, full_name text)
 * language sql
 * security definer
 * set search_path = public
 * as $$
 *   select id as user_id, full_name
 *   from sellers
 *   where is_active = true
 *   order by full_name;
 * $$;
 */

function Row({ s, onRename, onToggleActive, onDeleteHard }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.full_name);
  const activeTag = s.is_active ? { txt: "Actif", bg: "#16a34a" } : { txt: "Inactif", bg: "#9ca3af" };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onRename(s.id, trimmed);
    setEditing(false);
  };

  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between border rounded-2xl p-3 gap-3">
      <div className="flex-1">
        {editing ? (
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        ) : (
          <div className="font-medium">{s.full_name}</div>
        )}
        <div className="text-xs text-gray-500 mt-1">ID: {s.id}</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: activeTag.bg }}>
          {activeTag.txt}
        </span>

        {editing ? (
          <>
            <button className="btn" onClick={save}>💾 Enregistrer</button>
            <button className="btn" onClick={() => { setName(s.full_name); setEditing(false); }}>✖️ Annuler</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setEditing(true)}>✏️ Renommer</button>
            <button
              className="btn"
              onClick={() => onToggleActive(s.id, !s.is_active)}
              style={{ backgroundColor: s.is_active ? "#dc2626" : "#16a34a", color: "#fff", borderColor: "transparent" }}
            >
              {s.is_active ? "Désactiver" : "Réactiver"}
            </button>
            <button
              className="btn"
              onClick={() => onDeleteHard(s.id)}
              title="Suppression définitive (à éviter si des plannings/absences pointent vers cette vendeuse)"
              style={{ backgroundColor: "#7c2d12", color: "#fff", borderColor: "transparent" }}
            >
              🗑️ Supprimer (hard)
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function SellersAdmin() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [list, setList] = useState([]);
  const [filter, setFilter] = useState("all"); // all | active | inactive
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Sécurité / redirections
  useEffect(() => {
    if (loading) return;
    if (!session) r.replace("/login");
    if (profile && profile.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  const load = useCallback(async () => {
    // Si tu préfères l’RPC que tu utilises dans admin.js, tu peux remplacer par:
    // const { data } = await supabase.rpc("list_sellers");
    // et mapper pour afficher.
    const { data, error } = await supabase
      .from("sellers")
      .select("id, full_name, is_active, created_at")
      .order("full_name", { ascending: true });

    if (error) {
      console.error(error);
      alert("Impossible de charger les vendeuses.");
      return;
    }
    setList(data || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime pour garder la page synchro
  useEffect(() => {
    const ch = supabase
      .channel("sellers_rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "sellers" }, () => load())
      .subscribe();

    return () => supabase.removeChannel(ch);
  }, [load]);

  const visible = useMemo(() => {
    if (filter === "active") return list.filter((s) => s.is_active);
    if (filter === "inactive") return list.filter((s) => !s.is_active);
    return list;
  }, [list, filter]);

  const addSeller = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("sellers").insert({ full_name: name });
      if (error) throw error;
      setNewName("");
    } catch (e) {
      console.error(e);
      alert("Échec d’ajout.");
    } finally {
      setBusy(false);
    }
  };

  const renameSeller = async (id, name) => {
    try {
      const { error } = await supabase.from("sellers").update({ full_name: name }).eq("id", id);
      if (error) throw error;
    } catch (e) {
      console.error(e);
      alert("Échec de renommage.");
    }
  };

  const toggleActive = async (id, newVal) => {
    try {
      const { error } = await supabase.from("sellers").update({ is_active: newVal }).eq("id", id);
      if (error) throw error;
    } catch (e) {
      console.error(e);
      alert("Échec de la mise à jour actif/inactif.");
    }
  };

  // Suppression définitive (⚠️ attention aux FKs si tes plannings/absences pointent vers sellers.id)
  const deleteHard = async (id) => {
    if (!confirm("Supprimer définitivement cette vendeuse ? (irréversible)")) return;
    try {
      const { error } = await supabase.from("sellers").delete().eq("id", id);
      if (error) throw error;
    } catch (e) {
      console.error(e);
      alert("Échec de suppression (peut-être des références existantes : plannings, absences…). Utilise plutôt Désactiver.");
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Gérer les vendeuses</div>
        <div className="flex items-center gap-2">
          <Link href="/admin" legacyBehavior><a className="btn">⬅️ Retour admin</a></Link>
        </div>
      </div>

      {/* Ajouter */}
      <div className="card">
        <div className="font-semibold mb-2">Ajouter une vendeuse</div>
        <div className="grid sm:grid-cols-3 gap-2">
          <input
            className="input sm:col-span-2"
            placeholder="Nom et prénom"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSeller()}
          />
          <button className="btn" onClick={addSeller} disabled={busy}>
            ➕ Ajouter
          </button>
        </div>
        <div className="text-xs text-gray-500 mt-2">
          Astuce : préfère <b>Désactiver</b> plutôt que supprimer si cette vendeuse a déjà des lignes de planning/absences.
        </div>
      </div>

      {/* Filtre */}
      <div className="flex items-center gap-2">
        <span className="text-sm">Filtrer :</span>
        <button className="btn" onClick={() => setFilter("all")} style={{ opacity: filter === "all" ? 1 : 0.7 }}>Toutes</button>
        <button className="btn" onClick={() => setFilter("active")} style={{ opacity: filter === "active" ? 1 : 0.7 }}>Actives</button>
        <button className="btn" onClick={() => setFilter("inactive")} style={{ opacity: filter === "inactive" ? 1 : 0.7 }}>Inactives</button>
      </div>

      {/* Liste */}
      <div className="space-y-2">
        {visible.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse.</div>
        ) : (
          visible.map((s) => (
            <Row
              key={s.id}
              s={s}
              onRename={renameSeller}
              onToggleActive={toggleActive}
              onDeleteHard={deleteHard}
            />
          ))
        )}
      </div>

      {/* Styles de secours au cas où */}
      <style jsx global>{`
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
          padding: 0.55rem 0.9rem; border: 1px solid #e5e7eb; border-radius: 0.75rem;
          background: #111827; color: #fff; font-weight: 600; cursor: pointer;
        }
        .btn:hover { opacity: 0.9; }
        .card { border: 1px solid #e5e7eb; border-radius: 1rem; padding: 1rem; background: #fff; }
        .hdr { font-size: 1.125rem; font-weight: 700; }
        .select, .input {
          width: 100%; border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 0.5rem 0.75rem; background: #fff;
        }
      `}</style>
    </div>
  );
}
