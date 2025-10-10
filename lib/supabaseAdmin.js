// Serveur uniquement (NE PAS importer cÃ´tÃ© client)
import { createClient } from '@supabase/supabase-js';

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // secret serveur
  { auth: { autoRefreshToken: false, persistSession: false } }
);

