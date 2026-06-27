const admin = require("firebase-admin");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const SA        = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(SA) });
}
const db = admin.firestore();

async function fetchTodayPerformers() {
  const todayKey   = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  const todayStart = new Date(`${todayKey}T00:00:00+06:00`);

  const [attSnap, userSnap] = await Promise.all([
    db.collection("attempts")
      .where("submittedAt", ">=", todayStart)
      .orderBy("submittedAt", "desc")
      .limit(500)
      .get(),
    db.collection("users").limit(1000).get(),
  ]);

  const userMeta = new Map();
  for (const d of userSnap.docs) {
    const f    = d.data();
    const name = ((f.displayName) || ((f.email) ?? "").split("@")[0] || "").trim();
    if (name) userMeta.set(d.id, { name, college: (f.college ?? "").trim() });
  }

  const map = new Map();

  for (const d of attSnap.docs) {
    const f  = d.data();
    const xp = (f.xpEarned) ?? 0;

    if (f.isGuest) {
      const name = ((f.guestName) ?? "").trim();
      if (!name) continue;
      const key = `guest:${name.toLowerCase()}`;
      if (map.has(key)) { map.get(key).totalXP += xp; map.get(key).exams += 1; }
      else map.set(key, { name, college: (f.collegeName ?? "").trim(), totalXP: xp, exams: 1 });
    } else {
      const uid  = (f.userId) || "";
      if (!uid || uid === "guest") continue;
      const user = userMeta.get(uid);
      if (!user) continue;
      const key  = `user:${uid}`;
      if (map.has(key)) { map.get(key).totalXP += xp; map.get(key).exams += 1; }
      else map.set(key, { name: user.name, college: user.college, totalXP: xp, exams: 1 });
    }
  }

  for (const d of userSnap.docs) {
    const f         = d.data();
    const dailyXP   = f.dailyXP;
    const practiceXP = dailyXP ? (Number(dailyXP[todayKey]) || 0) : 0;
    if (practiceXP === 0) continue;
    const user = userMeta.get(d.id);
    if (!user) continue;
    const key = `user:${d.id}`;
    if (map.has(key)) { map.get(key).totalXP += practiceXP; }
    else map.set(key, { name: user.name, college: user.college, totalXP: practiceXP, exams: 0 });
  }

  return Array.from(map.values())
    .sort((a, b) => b.totalXP - a.totalXP)
    .slice(0, 25);
}

async function sendMessage(text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

async function main() {
  const performers = await fetchTodayPerformers();
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟",
    "1️⃣1️⃣","1️⃣2️⃣","1️⃣3️⃣","1️⃣4️⃣","1️⃣5️⃣","1️⃣6️⃣","1️⃣7️⃣","1️⃣8️⃣","1️⃣9️⃣","2️⃣0️⃣",
    "2️⃣1️⃣","2️⃣2️⃣","2️⃣3️⃣","2️⃣4️⃣","2️⃣5️⃣"];
  const today  = new Date().toLocaleDateString("bn-BD", { timeZone: "Asia/Dhaka", day: "numeric", month: "long" });

  if (performers.length === 0) {
    await sendMessage("আজকে কেউ পরীক্ষা দেয়নি। 😴");
    return;
  }

  let msg = `🏆 <b>আজকের Top Performers</b>\n`;
  msg    += `📅 ${today}\n`;
  msg    += `━━━━━━━━━━━━━━━\n\n`;

  for (let i = 0; i < performers.length; i++) {
    const p = performers[i];
    msg += `${medals[i]} <b>${p.name}</b> — ${p.totalXP} XP\n`;
    if (p.college) msg += `    🏫 ${p.college}\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━\n`;
  msg += `🔥 কাল আবার নতুন সুযোগ!\n`;
  msg += `👉 exammatebd.com`;

  await sendMessage(msg);
  console.log("Leaderboard sent successfully!");
}

main().catch(console.error);
