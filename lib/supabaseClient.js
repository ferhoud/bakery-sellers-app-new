<<<<<<< HEAD
// lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";
=======
﻿// lib/supabaseClient.js
import { createClient } from '@supabase/supabase-js';
>>>>>>> deploy-sellers

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

<<<<<<< HEAD
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY manquant(es).");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
=======
if (!url || !anon) {
  // ðŸ”´ Alerte visible en dev & prod si mal configurÃ©
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

export const supabase = createClient(url, anon);

>>>>>>> deploy-sellers
