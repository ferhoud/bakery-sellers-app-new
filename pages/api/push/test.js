// pages/api/push/test.js
import webpush from 'web-push';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function ensureVAPID(){
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const prv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !prv) throw new Error('VAPID keys missing');
  webpush.setVapidDetails('mailto:admin@example.com', pub, prv);
}

export default async function handler(req,res){
  if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try {
    ensureVAPID();
    const { endpoint } = req.body || {};
    const supabase = getSupabaseAdmin();

    let sub;
    if (endpoint){
      const { data, error } = await supabase.from('push_subscriptions').select('*').eq('endpoint', endpoint).single();
      if (error) return res.status(404).json({ error:'Subscription not found' });
      sub = { endpoint: data.endpoint, keys: data.keys };
    } else {
      const { data, error } = await supabase.from('push_subscriptions').select('*').order('created_at',{ascending:false}).limit(1);
      if (error || !data?.length) return res.status(404).json({ error:'No subscriptions' });
      const s = data[0]; sub = { endpoint: s.endpoint, keys: s.keys };
    }

    const payload = JSON.stringify({ title:'Test de notification', body:'Ça marche ! 👍', data:{ url:'/admin' } });
    await webpush.sendNotification(sub, payload);
    return res.status(200).json({ ok:true });
  } catch(e){
    if (e?.statusCode===410 || e?.statusCode===404){
      try {
        if (req.body?.endpoint){
          const supabase = getSupabaseAdmin();
          await supabase.from('push_subscriptions').delete().eq('endpoint', req.body.endpoint);
        }
      } catch {}
      return res.status(410).json({ error:'Subscription invalid, removed' });
    }
    return res.status(500).json({ error:'Failed to send push' });
  }
}
