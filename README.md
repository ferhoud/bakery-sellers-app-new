
# Bakery Sellers App (Nouveau départ)

Application simple pour gérer **planning des vendeuses**, **absences** et **totaux d'heures**.
Stack: **Next.js 14 + Tailwind + Supabase**.

## 🚀 Déploiement rapide (Windows / Vercel)

1. **Créer un projet Supabase** (neuf).
2. Dans Supabase → SQL Editor, **copie-colle tout le script** de `supabase_schema.sql` et exécute-le.
3. Dans Supabase → Auth → Users, **crée les comptes** (email + mot de passe) pour :
   - Toi (Farid) → rôle `admin`.
   - Antonia, Olivia, Colleen, Ibtissam → rôle `seller`.
4. Récupère **SUPABASE_URL** et **ANON KEY** (Settings → API).
5. Dans Vercel, crée un **nouveau projet** depuis ce repo/zip, et ajoute les variables d’environnement :
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
6. Lance `npm install` puis `npm run build` puis `npm start` (en local) ou laisse Vercel builder.

## 👤 Rôles & Accès
- **Admin (Farid)** : crée & modifie le planning hebdo, voit les absences, calcule les totaux.
- **Vendeuses** : se connectent, **consultent** leur planning et **demandent une absence**.

## 🧱 Structure des données
- `profiles(user_id, full_name, role)`
- `shift_types(code, label, start_time, end_time, hours)`
- `shifts(date, shift_code, seller_id)` (unique par date+créneau)
- `absences(date, seller_id, reason, status)`
- `hours_for_range(uuid, date, date)` : calcule les heures sur une période.

## 🗓️ Créneaux par défaut
- Matin : **6h30–13h30** (7 h)
- Midi : **7h–13h** (6 h)
- Soir : **13h30–20h30** (7 h)

## 🔐 RLS Policies (sécurité)
- Lecture planning: **tous les utilisateurs connectés** (vendeuses lisent).
- Écriture planning & validation absences: **admin uniquement**.
- Demande d'absence : **vendeuse pour elle-même**.

## 🔧 Variables d’environnement
Copie `.env.local.example` → `.env.local` et renseigne tes valeurs.

## 📁 Scripts utiles
- Dev local : `npm run dev`
- Build prod : `npm run build`
- Start : `npm start`

Bon démarrage propre ✨
