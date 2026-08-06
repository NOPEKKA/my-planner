/* ตัวส่ง push แจ้งเตือน — รันโดย GitHub Actions ตามรอบเวลา
   เตือน: การบ้าน / สอบ / นัด (ตามเวลา) + วันสำคัญ (3วัน/1วัน/วันนั้น) + สิ่งที่ต้องทำภายในสัปดาห์ (ทุกเย็น)
   ส่งครั้งเดียวต่อ (รายการ × ระยะเตือน) โดยจดไว้ใน _pushlog กันส่งซ้ำ
   ใช้เวลาไทย (UTC+7) ในการตัดสินวัน/ช่วงเช้า-เย็น */

const admin = require('firebase-admin');

if (!process.env.SERVICE_ACCOUNT) {
  console.error('ไม่พบ SERVICE_ACCOUNT (ตั้ง GitHub secret ก่อน)');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT)) });
const db = admin.firestore();

// [นาทีก่อนถึงกำหนด, รหัสกันซ้ำ, ข้อความ]
const RULES = {
  homework: [[24 * 60, '1d', 'ครบกำหนดพรุ่งนี้'], [120, '2h', 'อีกไม่ถึง 2 ชั่วโมง']],
  exams:    [[3 * 24 * 60, '3d', 'สอบในอีก 3 วัน'], [24 * 60, '1d', 'สอบพรุ่งนี้!'], [120, '2h', 'สอบในอีกไม่ถึง 2 ชั่วโมง']],
  appts:    [[24 * 60, '1d', 'นัดพรุ่งนี้'], [60, '1h', 'อีก 1 ชั่วโมง']],
};
const timeOf  = (coll, it) => (coll === 'homework' ? it.dueAt : it.at);
const titleOf = (coll, it) =>
  coll === 'homework' ? `📚 ส่ง: ${it.title || ''}`
  : coll === 'exams'  ? `📝 สอบ: ${it.subject || ''}`
  :                     `📌 ${it.title || ''}`;

const now = Date.now();
// เวลาไทย: อ่านผ่าน getUTC* ของเวลาที่บวก 7 ชม.แล้ว
const TH = new Date(now + 7 * 3600000);
const thHour = TH.getUTCHours();
const today = Date.UTC(TH.getUTCFullYear(), TH.getUTCMonth(), TH.getUTCDate()); // เที่ยงคืนวันนี้ (ไทย)
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const ymdOf = (ts) => new Date(ts).toISOString().slice(0, 10);

// รอบถัดไปของวันสำคัญ (คืนค่า timestamp เที่ยงคืน)
function nextOccurTS(o) {
  const b = new Date(o.date + 'T00:00:00Z');
  const bM = b.getUTCMonth(), bD = b.getUTCDate();
  const ty = new Date(today).getUTCFullYear(), tm = new Date(today).getUTCMonth();
  if (o.repeat === 'monthly') {
    for (let i = 0; i < 2; i++) { const y = ty, m = tm + i; const ts = Date.UTC(y, m, Math.min(bD, lastDay(y, m))); if (ts >= today) return ts; }
    return today;
  }
  let ts = Date.UTC(ty, bM, bD);
  if (ts < today) ts = Date.UTC(ty + 1, bM, bD);
  return ts;
}

(async () => {
  const spaces = await db.collection('spaces').listDocuments();
  let sent = 0;

  // ส่ง 1 ครั้งต่อ logId (กันซ้ำ) + ลบ token เสีย
  async function pushOnce(sp, tokens, logId, title, body) {
    const log = sp.collection('_pushlog').doc(logId);
    if ((await log.get()).exists) return 0;
    const resp = await admin.messaging().sendEachForMulticast({
      tokens, notification: { title, body }, webpush: { fcmOptions: { link: '/' } },
    });
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = (r.error && r.error.code) || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))
          sp.collection('_pushtokens').doc(tokens[i]).delete().catch(() => {});
      }
    });
    await log.set({ sentAt: now, ok: resp.successCount });
    console.log(`ส่ง "${title}" (${logId}) → ${resp.successCount}/${tokens.length}`);
    return resp.successCount;
  }

  for (const sp of spaces) {
    const tokSnap = await sp.collection('_pushtokens').get();
    let tokens = tokSnap.docs.map((d) => d.id);
    if (!tokens.length) continue;

    // ===== การบ้าน / สอบ / นัด (ตามเวลา) =====
    for (const coll of ['homework', 'exams', 'appts']) {
      const snap = await sp.collection(coll).get();
      for (const doc of snap.docs) {
        const it = doc.data();
        if (coll === 'homework' && it.done) continue;
        const t = new Date(timeOf(coll, it)).getTime();
        if (isNaN(t)) continue;
        const minsLeft = (t - now) / 60000;
        if (minsLeft <= 0) continue;

        const matching = RULES[coll].filter(([thr]) => minsLeft <= thr).sort((a, b) => a[0] - b[0]);
        if (!matching.length) continue;

        const [, tightLabel, tightWord] = matching[0];
        const tightLog = sp.collection('_pushlog').doc(`${doc.id}_${tightLabel}`);
        if ((await tightLog.get()).exists) continue;

        const resp = await admin.messaging().sendEachForMulticast({
          tokens, notification: { title: titleOf(coll, it), body: tightWord }, webpush: { fcmOptions: { link: '/' } },
        });
        resp.responses.forEach((r, i) => {
          if (!r.success) {
            const code = (r.error && r.error.code) || '';
            if (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))
              sp.collection('_pushtokens').doc(tokens[i]).delete().catch(() => {});
          }
        });
        await Promise.all(matching.map(([, label]) =>
          sp.collection('_pushlog').doc(`${doc.id}_${label}`).set({ sentAt: now, ok: resp.successCount })));
        sent += resp.successCount;
        console.log(`ส่ง "${titleOf(coll, it)}" (${tightLabel}) → ${resp.successCount}/${tokens.length}`);
      }
    }

    // ===== วันสำคัญ — 3 วันก่อน / 1 วันก่อน / เช้าวันนั้น =====
    const occSnap = await sp.collection('occasions').get();
    for (const doc of occSnap.docs) {
      const o = doc.data();
      const ts = nextOccurTS(o), n = Math.round((ts - today) / 86400000), dk = ymdOf(ts);
      if (n === 3) sent += await pushOnce(sp, tokens, `${doc.id}_occ3_${dk}`, `🎉 ${o.title || ''}`, 'อีก 3 วัน');
      if (n === 1) sent += await pushOnce(sp, tokens, `${doc.id}_occ1_${dk}`, `🎉 ${o.title || ''}`, 'พรุ่งนี้แล้ว!');
      if (n === 0 && thHour >= 7) sent += await pushOnce(sp, tokens, `${doc.id}_occ0_${dk}`, `🎉 ${o.title || ''}`, 'วันนี้! 🎉');
    }

    // ===== สิ่งที่ต้องทำภายในสัปดาห์ — ทุกเย็น (18:00–22:00 ไทย) ถ้ายังไม่เสร็จ =====
    if (thHour >= 18 && thHour < 22) {
      const rtSnap = await sp.collection('routines').get();
      for (const doc of rtSnap.docs) {
        const r = doc.data();
        if (!r.countdown || r.done || !r.date) continue;
        const b = new Date(r.date + 'T00:00:00Z');
        const dlTS = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
        if (today > dlTS) continue; // เลยกำหนดแล้ว
        const daysLeft = Math.round((dlTS - today) / 86400000);
        sent += await pushOnce(sp, tokens, `${doc.id}_eve_${ymdOf(today)}`, `⏳ ${r.title || ''}`,
          daysLeft <= 0 ? 'ยังไม่เสร็จ · ต้องทำให้เสร็จภายในวันนี้!' : `ยังไม่เสร็จ · เหลือ ${daysLeft} วันในสัปดาห์นี้`);
      }
    }
  }
  console.log(`เสร็จ ส่งทั้งหมด ${sent} ข้อความ`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
