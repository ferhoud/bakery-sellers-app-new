// lib/pushNotify.js
export async function notifyAdminsNewAbsence({ sellerName, startDate, endDate }) {
  try {
    await fetch('/api/push/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Nouvelle demande d’absence',
        body: `${sellerName || 'Vendeuse'} — ${startDate}${endDate && endDate !== startDate ? ` → ${endDate}` : ''}`,
        url: '/admin',
      }),
    });
  } catch (e) {
    // Notifications désactivées / route absente : on ignore proprement
    console.warn('notifyAdminsNewAbsence skipped:', e?.message || e);
  }
}
