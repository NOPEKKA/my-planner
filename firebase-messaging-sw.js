/* Service worker สำหรับ Firebase Cloud Messaging
   ต้องวางไฟล์นี้ไว้ที่ "ราก" ของเว็บ (โฟลเดอร์เดียวกับ index.html)
   เช่น https://nopekka.github.io/my-planner/firebase-messaging-sw.js */

importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCBelgwSgNH6GCNTWcexbzIj9M1l5DvUxY",
  authDomain: "weber-schedule.firebaseapp.com",
  projectId: "weber-schedule",
  storageBucket: "weber-schedule.firebasestorage.app",
  messagingSenderId: "790411034540",
  appId: "1:790411034540:web:a6b46e2a2b968ae78c4409"
});

const messaging = firebase.messaging();

// รับข้อความตอนแอป "ปิดอยู่" แล้วแสดงเป็น notification
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'ตารางของฉัน', {
    body: n.body || '',
    tag: (payload.data && payload.data.tag) || 'planner',
    data: payload.data || {},
  });
});

// แตะ notification แล้วเปิดแอป
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('./');
  }));
});
