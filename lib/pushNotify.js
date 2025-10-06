// lib/pushNotify.js
export async function notifyAdminsNewAbsence({ sellerName, startDate, endDate }) {
  try {
    const title = 'Nouvelle demande d’absence';
    const body =
      `${sellerName || 'Vendeuse'} a demandé une absence ` +
      `(${formatDate(startDate)} → ${formatDate(endDate || startDate)}).`;

    await fetch('/api/push/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body,
        url: '/admin?tab=absences',
        role: 'admin',
      }),
    });
  } catch (e) {
    console.warn('[push] notifyAdminsNewAbsence failed:', e?.message || e);
  }
}

function formatDate(d) {
  if (!d) return '';
  try {
    const x = typeof d === 'string' ? new Date(d) : d;
    return x.toLocaleDateString('fr-FR');
  } catch {
    return String(d);
  }
}
