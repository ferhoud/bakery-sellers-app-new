export default function handler(req, res) {
  res.json({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || null,
    anonKeyLen: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.length : 0,
    hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    nodeEnv: process.env.NODE_ENV,
  });
}
