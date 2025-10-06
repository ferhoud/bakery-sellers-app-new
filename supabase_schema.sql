
-- === INITIALISATION SCHEMA POUR SUPABASE ===
-- Activer les extensions utiles
create extension if not exists pgcrypto;
create extension if not exists uuid-ossp;

-- PROFILS (rôle: admin/seller)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin','seller')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Politique: chaque utilisateur peut voir son profil, l'admin voit tout
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (auth.uid() = user_id or exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'));

-- Politique: seul admin peut insérer/mettre à jour/supprimer
drop policy if exists "profiles_modify" on public.profiles;
create policy "profiles_modify" on public.profiles
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'));

-- TYPES DE CRENEAUX
create table if not exists public.shift_types (
  code text primary key,
  label text not null,
  start_time time not null,
  end_time time not null,
  hours numeric not null
);
alter table public.shift_types enable row level security;
drop policy if exists "shift_types_read" on public.shift_types;
create policy "shift_types_read" on public.shift_types for select to authenticated using (true);
drop policy if exists "shift_types_admin" on public.shift_types;
create policy "shift_types_admin" on public.shift_types for all to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'));

insert into public.shift_types (code, label, start_time, end_time, hours)
  values
  ('MORNING','6h30–13h30', '06:30', '13:30', 7),
  ('MIDDAY','7h–13h', '07:00', '13:00', 6),
  ('EVENING','13h30–20h30', '13:30', '20:30', 7)
on conflict (code) do nothing;

-- PLANNING (assignations)
create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  shift_code text not null references public.shift_types(code) on delete restrict,
  seller_id uuid null references auth.users(id) on delete set null,
  inserted_at timestamptz not null default now(),
  unique(date, shift_code)
);
alter table public.shifts enable row level security;

-- Politique lecture: tout authentifié peut voir (vendeuses lisent le planning)
drop policy if exists "shifts_read_all" on public.shifts;
create policy "shifts_read_all" on public.shifts for select to authenticated using (true);

-- Politique écriture: seulement admin
drop policy if exists "shifts_admin_write" on public.shifts;
create policy "shifts_admin_write" on public.shifts for all to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'));

-- ABSENCES
create table if not exists public.absences (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  seller_id uuid not null references auth.users(id) on delete cascade,
  reason text null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
alter table public.absences enable row level security;

-- Lecture: tout authentifié (pour la bannière "Aucune absence aujourd'hui")
drop policy if exists "absences_read" on public.absences;
create policy "absences_read" on public.absences for select to authenticated using (true);

-- Insertion: vendeur peut créer sa propre demande
drop policy if exists "absences_insert_self" on public.absences;
create policy "absences_insert_self" on public.absences for insert to authenticated
  with check (auth.uid() = seller_id);

-- Mise à jour/suppression: seulement admin
drop policy if exists "absences_admin_write" on public.absences;
create policy "absences_admin_write" on public.absences for update using
  (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'));
drop policy if exists "absences_admin_delete" on public.absences;
create policy "absences_admin_delete" on public.absences for delete using
  (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role='admin'));

-- VUES utiles
create or replace view public.view_week_assignments as
select s.date, s.shift_code, s.seller_id, p.full_name
from public.shifts s
left join public.profiles p on p.user_id = s.seller_id;

create or replace view public.view_week_for_user as
select s.date, s.shift_code, s.seller_id
from public.shifts s;

-- FONCTION pour total heures sur une période
create or replace function public.hours_for_range(p_seller uuid, p_from date, p_to date)
returns numeric language sql stable as $$
  select coalesce(sum(t.hours),0)
  from public.shifts s
  join public.shift_types t on t.code = s.shift_code
  where s.seller_id = p_seller
    and s.date between p_from and p_to;
$$;

-- === CREATION DES COMPTES ===
-- 1) Crée chaque utilisateur (vendeuse + toi) dans Auth > Users du dashboard Supabase (email + mot de passe).
-- 2) Pour chacun, insère son profil avec le bon rôle et le nom complet :
--    Remplace les UUID ci-dessous par les IDs réels (copier depuis Auth > Users).
--    Exemple :
-- insert into public.profiles (user_id, full_name, role) values ('<UUID_FARID>', 'Farid', 'admin');
-- insert into public.profiles (user_id, full_name, role) values ('<UUID_ANTONIA>', 'Antonia', 'seller');
-- insert into public.profiles (user_id, full_name, role) values ('<UUID_OLIVIA>', 'Olivia', 'seller');
-- insert into public.profiles (user_id, full_name, role) values ('<UUID_COLLEEN>', 'Colleen', 'seller');
-- insert into public.profiles (user_id, full_name, role) values ('<UUID_IBTISSAM>', 'Ibtissam', 'seller');
