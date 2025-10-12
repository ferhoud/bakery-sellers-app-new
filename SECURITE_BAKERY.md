# 🔐 Sécurité Supabase — Projet `bakery-sellers-app-new`

**Mise à jour : 11 octobre 2025 — version sécurisée complète**

Ce document décrit toutes les politiques de sécurité **Row Level Security (RLS)** et les droits appliqués aux tables principales du projet.  
L’objectif est d’assurer que :
- chaque **vendeuse** ne voit que ses propres données,
- les **admins** ont un accès complet à toutes les informations,
- aucune donnée n’est visible sans authentification.

---

## 🧱 1. Table `profiles`

### Description
Contient les informations de chaque utilisateur (`user_id`, `full_name`, `role`, …).

### Politiques

| Action | Condition | Vendeuse | Admin |
|--------|------------|-----------|--------|
| **SELECT** | `user_id = auth.uid()` ou `role = 'admin'` | ✅ Son profil uniquement | ✅ Tous les profils |
| **INSERT** | `user_id = auth.uid()` ou admin | ✅ Son propre profil | ✅ Tous |
| **UPDATE** | `user_id = auth.uid()` ou admin | ✅ Son profil | ✅ Tous |
| **DELETE** | admin uniquement | ❌ Non | ✅ Oui |

### Résumé
Chaque vendeuse gère son propre profil.  
L’admin a un contrôle total.

---

## 🧱 2. Table `absences`

### Description
Enregistre les absences à la journée des vendeuses.

### Politiques

| Action | Condition | Vendeuse | Admin |
|--------|------------|-----------|--------|
| **SELECT** | `seller_id = auth.uid()` ou admin | ✅ Ses absences | ✅ Toutes |
| **INSERT** | `seller_id = auth.uid()` ou admin | ✅ Oui | ✅ Oui |
| **UPDATE** | admin uniquement | ❌ Non | ✅ Oui |
| **DELETE** | `seller_id = auth.uid()` ou admin | ✅ Ses absences à venir | ✅ Toutes |

### Résumé
Les vendeuses ne peuvent créer ou supprimer que leurs propres absences.  
L’admin peut corriger ou supprimer n’importe laquelle.

---

## 🧱 3. Table `leaves`

### Description
Demande de **congés** sur plusieurs jours.

### Politiques

| Action | Condition | Vendeuse | Admin |
|--------|------------|-----------|--------|
| **SELECT** | `seller_id = auth.uid()` ou admin | ✅ Ses congés | ✅ Tous |
| **INSERT** | `seller_id = auth.uid()` ou admin | ✅ Oui | ✅ Oui |
| **UPDATE** | admin uniquement | ❌ Non | ✅ Oui |
| **DELETE** | `seller_id = auth.uid()` ou admin | ✅ Ses congés | ✅ Tous |

### Résumé
Même logique que les absences, mais sur plusieurs jours.

---

## 🧱 4. Table `replacement_interest`

### Description
Stocke les propositions de remplacement (vendeuses volontaires).

### Politiques

| Action | Condition | Vendeuse | Admin |
|--------|------------|-----------|--------|
| **SELECT** | `volunteer_id = auth.uid()` ou admin | ✅ Ses volontariats | ✅ Tous |
| **INSERT** | `volunteer_id = auth.uid()` ou admin | ✅ Oui | ✅ Oui |
| **UPDATE** | admin uniquement | ❌ Non | ✅ Oui |
| **DELETE** | `volunteer_id = auth.uid()` ou admin | ✅ Ses propositions | ✅ Toutes |

### Résumé
Chaque vendeuse peut voir et gérer uniquement ses propres volontariats.  
L’admin garde un contrôle total.

---

## 🧱 5. Vue `view_week_assignments`

### Description
Vue combinée (lecture seule) pour le **planning hebdomadaire**.

### Accès

| Action | Condition | Vendeuse | Admin | Public |
|--------|------------|-----------|--------|--------|
| **SELECT** | `auth.role() = 'authenticated'` | ✅ Oui | ✅ Oui | ❌ Non |

### Résumé
Lecture autorisée uniquement pour les utilisateurs connectés.

---

## ✅ Résumé global

| Table / Vue | Vendeuse : Lecture | Vendeuse : Écriture | Admin : Lecture/Écriture | Anonyme |
|--------------|--------------------|----------------------|---------------------------|----------|
| `profiles` | ✅ Son profil | ✅ Son profil | ✅ Tout | ❌ |
| `absences` | ✅ Ses absences | ✅ Créer / Supprimer | ✅ Tout | ❌ |
| `leaves` | ✅ Ses congés | ✅ Créer / Supprimer | ✅ Tout | ❌ |
| `replacement_interest` | ✅ Ses propositions | ✅ Ses propositions | ✅ Tout | ❌ |
| `view_week_assignments` | ✅ Lecture seule | ❌ | ✅ Lecture seule | ❌ |

---

## 🧰 Bonnes pratiques

1. Utiliser `supabase.auth.getUser()` côté client pour récupérer `user.id`.
2. Ne jamais exposer de logique d’admin côté front.
3. Tester les accès avec différents rôles.
4. Sauvegarder régulièrement ce fichier pour pouvoir rejouer les policies.

---
© 2025 — Configuration de sécurité validée par Farid Mrabet
