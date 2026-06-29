/* ตัวส่ง push แจ้งเตือน — รันโดย GitHub Actions ตามรอบเวลา
   อ่านการบ้าน/นัด/สอบจาก Firestore แล้วส่ง FCM ไปยังเครื่องที่ลงทะเบียนไว้
   ส่งครั้งเดียวต่อ (รายการ × ระยะเตือน) โดยจดไว้ใน _pushlog กันส่งซ้ำ */

const admin = require('firebase-admin');

if (!process.env.SERVICE_ACCOUNT) {
  console.error('ไม่พบ SERVICE_ACCOUNT (ตั้ง GitHub secret ก่อน)');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT)),
});
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

(async () => {
  const now = Date.now();
  const spaces = await db.collection('spaces').listDocuments();
  let sent = 0;

  for (const sp of spaces) {
    const tokSnap = await sp.collection('_pushtokens').get();
    let tokens = tokSnap.docs.map((d) => d.id);
    if (!tokens.length) continue;

    for (const coll of ['homework', 'exams', 'appts']) {
      const snap = await sp.collection(coll).get();
      for (const doc of snap.docs) {
        const it = doc.data();
        if (coll === 'homework' && it.done) continue;
        const t = new Date(timeOf(coll, it)).getTime();
        if (isNaN(t)) continue;
        const minsLeft = (t - now) / 60000;
        if (minsLeft <= 0) continue;

        // เกณฑ์ที่เข้าเงื่อนไข เรียงจาก "ใกล้สุด → กว้างสุด"
        const matching = RULES[coll].filter(([thr]) => minsLeft <= thr).sort((a, b) => a[0] - b[0]);
        if (!matching.length) continue;

        const [, tightLabel, tightWord] = matching[0];
        const tightLog = sp.collection('_pushlog').doc(`${doc.id}_${tightLabel}`);
        if ((await tightLog.get()).exists) continue; // ระดับนี้เตือนไปแล้ว

        // ส่งเฉพาะระดับที่ใกล้สุด
        const resp = await admin.messaging().sendEachForMulticast({
          tokens,
          notification: { title: titleOf(coll, it), body: tightWord },
          webpush: { fcmOptions: { link: '/' } },
        });
        // ลบ token ที่ใช้ไม่ได้แล้ว
        resp.responses.forEach((r, i) => {
          if (!r.success) {
            const code = (r.error && r.error.code) || '';
            if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
              sp.collection('_pushtokens').doc(tokens[i]).delete().catch(() => {});
            }
          }
        });
        // จดทุกระดับที่เข้าเงื่อนไขแล้ว (รวมระดับกว้างกว่า) กันส่งข้อความเก่าที่ผิดเวลา
        await Promise.all(matching.map(([, label]) =>
          sp.collection('_pushlog').doc(`${doc.id}_${label}`).set({ sentAt: now, ok: resp.successCount })));
        sent += resp.successCount;
        console.log(`ส่ง "${titleOf(coll, it)}" (${tightLabel}) → ${resp.successCount}/${tokens.length}`);
      }
    }
  }
  console.log(`เสร็จ ส่งทั้งหมด ${sent} ข้อความ`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
