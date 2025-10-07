// pages/admin/sellers.js
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/lib/useAuth';

function Badge({ children, color = '#111827' }) {
  return (
    <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: color, color: '#fff' }}>
      {children}
    </span>
  );
}

export default function AdminSellers() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [items, setItems] = useState([]); // [{id,email,full_name,active,banned_until,color,created_at}]
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', password: '', color: '' });
  const [msg, setMsg] = useState('');

  // Sécurité
  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace('/login'); return; }
    if (profile?.role !== 'admin') { r.replace('/app'); return; }
  }, [session, profile, loading, r]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/users/list');
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'list failed');
      setItems(j.users || []);
    } catch (e) {
      console.error(e);
      setMsg('Lecture des vendeuses impossible (API).');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // CREATE
  const onCreate = async (e) => {
    e.preventDefault();
    setMsg('');
    if (!form.full_name || !form.email || !form.password) {
      setMsg('Nom, email et mot de passe sont requis.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'create failed');
      setForm({ full_name: '', email: '', password: '', color: '' });
      await load();
      setMsg('Vendeuse créée ✅');
    } catch (e) {
      console.error(e);
      setMsg('Création impossible : ' + (e.message || ''));
    } finally {
      setBusy(false);
    }
  };

  // UPDATE (nom/email/couleur/mot de passe)
  const updateField = async (user_id, patch) => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id, ...patch }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'update failed');
      await load();
      setMsg('Modifications enregistrées ✅');
    } catch (e) {
      console.error(e);
      setMsg('Modification impossible : ' + (e.message || ''));
    } finally {
      setBusy(false);
    }
  };

  // SUSPEND / UNSUSPEND
  const toggleSuspend = async (u) => {
    const suspend = !(u?.active ?? true) ? false : true; // si active → suspendre ; si inactif → réactiver
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: u.id,
          suspend, // true => ban; false => unban
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'suspend failed');
      await load();
      setMsg(suspend ? 'Compte suspendu ✅' : 'Compte réactivé ✅');
    } catch (e) {
      console.error(e);
      setMsg('Action impossible : ' + (e.message || ''));
    } finally {
      setBusy(false);
    }
  };

  // DELETE (DANGER) — hard delete (ne touche pas l’historique si tes FK ne sont pas en CASCADE)
  const hardDelete = async (u) => {
    if (!window.confirm(`Supprimer définitivement ${u.full_name || u.email} ?\nL'historique (absences, shifts) restera, mais la personne ne pourra plus se connecter.`)) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: u.id, hard: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'delete failed');
      await load();
      setMsg('Compte supprimé définitivement ✅');
    } catch (e) {
      console.error(e);
      setMsg('Suppression impossible : ' + (e.message || ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Gestion des vendeuses</div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => window.location.href = '/admin'}>← Retour admin</button>
          <button className="btn" onClick={() => load()} disabled={busy}>Recharger</button>
        </div>
      </div>

      {/* Formulaire création */}
      <div className="card">
        <div className="hdr mb-2">Ajouter une vendeuse</div>
        <form className="grid md:grid-cols-5 gap-3 items-end" onSubmit={onCreate}>
          <div className="md:col-span-2">
            <div className="text-sm mb-1">Nom complet</div>
            <input className="input" value={form.full_name} onChange={(e)=>setForm(f=>({...f, full_name:e.target.value}))} placeholder="Ex : Antonia Rossi" />
          </div>
          <div>
            <div className="text-sm mb-1">Email</div>
            <input className="input" type="email" value={form.email} onChange={(e)=>setForm(f=>({...f, email:e.target.value}))} placeholder="vendeuse@vendeuses.local" />
          </div>
          <div>
            <div className="text-sm mb-1">Mot de passe</div>
            <input className="input" type="password" value={form.password} onChange={(e)=>setForm(f=>({...f, password:e.target.value}))} placeholder="••••••••" />
          </div>
          <div>
            <div className="text-sm mb-1">Couleur (optionnel)</div>
            <input className="input" type="text" value={form.color} onChange={(e)=>setForm(f=>({...f, color:e.target.value}))} placeholder="#64b5f6" />
          </div>
          <div className="md:col-span-5">
            <button className="btn" type="submit" disabled={busy}>Créer la vendeuse</button>
          </div>
        </form>
        {msg && <div className="text-sm mt-2">{msg}</div>}
      </div>

      {/* Liste / édition rapide */}
      <div className="card">
        <div className="hdr mb-2">Vendeuses</div>
        {items.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse pour l’instant.</div>
        ) : (
          <div className="space-y-2">
            {items.map(u => (
              <div key={u.id} className="border rounded-2xl p-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{u.full_name || '—'}</div>
                    <div className="text-sm text-gray-600 truncate">{u.email}</div>
                    <div className="flex items-center gap-2 mt-1">
                      {u.active ? <Badge color="#16a34a">Actif</Badge> : <Badge color="#6b7280">Suspendu</Badge>}
                      {u.banned_until ? <Badge color="#ef4444">Banni</Badge> : null}
                      {u.color ? <span className="text-xs px-2 py-1 rounded-full border" style={{ borderColor: '#e5e7eb' }}>Couleur : <span style={{ color: u.color, fontWeight: 600 }}>{u.color}</span></span> : null}
                      <span className="text-xs text-gray-500">ID : {u.id}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn" onClick={() => {
                      const full_name = prompt('Nouveau nom complet ?', u.full_name || '');
                      if (full_name != null) updateField(u.id, { full_name });
                    }} disabled={busy}>Modifier nom</button>

                    <button className="btn" onClick={() => {
                      const color = prompt('Couleur (ex: #64b5f6) ?', u.color || '');
                      if (color != null) updateField(u.id, { color });
                    }} disabled={busy}>Couleur</button>

                    <button className="btn" onClick={() => {
                      const email = prompt('Nouvel email ?', u.email || '');
                      if (email != null) updateField(u.id, { email });
                    }} disabled={busy}>Changer email</button>

                    <button className="btn" onClick={() => {
                      const password = prompt('Nouveau mot de passe ? (min 6)');
                      if (password) updateField(u.id, { password });
                    }} disabled={busy}>Réinitialiser mot de passe</button>

                    <button className="btn" onClick={() => toggleSuspend(u)} disabled={busy}
                      style={{ backgroundColor: u.active ? '#f59e0b' : '#16a34a', color: '#fff', borderColor: 'transparent' }}>
                      {u.active ? 'Suspendre' : 'Réactiver'}
                    </button>

                    <button className="btn" onClick={() => hardDelete(u)} disabled={busy}
                      style={{ backgroundColor: '#ef4444', color: '#fff', borderColor: 'transparent' }}>
                      Supprimer (définitif)
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
