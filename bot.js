const admin = require("firebase-admin");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID || !process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ Missing required env vars: BOT_TOKEN, CHAT_ID, or FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}

let SA;
try {
  SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message);
  process.exit(1);
}

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
    const f   = d.data();
    const xp  = (f.xpEarned) ?? 0;
    const uid = (f.userId) || "";
    if (!uid || uid === "guest" || uid === "batch") continue;
    const user = userMeta.get(uid);
    if (!user) continue;
    const key = `user:${uid}`;
    if (map.has(key)) { map.get(key).totalXP += xp; map.get(key).exams += 1; }
    else map.set(key, { name: user.name, college: user.college, totalXP: xp, exams: 1 });
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

async function batchStats() {
  const batchSnap = await db.collection("attempts")
    .where("isBatch", "==", true)
    .limit(2000)
    .get();

  const students = new Set();
  const examIds  = new Set();

  for (const d of batchSnap.docs) {
    const f    = d.data();
    const name = (f.guestName || "").trim();
    const eid  = (f.examId   || "").trim();
    if (name) students.add(name);
    if (eid)  examIds.add(eid);
  }

  let msg = `📊 <b>Batch Exam Stats</b>\n`;
  msg    += `━━━━━━━━━━━━━━━\n`;
  msg    += `👥 মোট শিক্ষার্থী: <b>${students.size} জন</b>\n`;
  msg    += `📝 মোট batch exam: <b>${examIds.size}টি</b>\n`;
  msg    += `📋 মোট attempt: <b>${batchSnap.size}টি</b>`;

  await sendMessage(msg);
  console.log(`Batch stats: ${students.size} students, ${examIds.size} exams, ${batchSnap.size} attempts`);
}

async function warnBatchMisses() {
  // Fetch all batch attempts (no orderBy to avoid composite index requirement)
  const batchSnap = await db.collection("attempts")
    .where("isBatch", "==", true)
    .limit(2000)
    .get();

  if (batchSnap.empty) {
    await sendMessage("⚠️ কোনো batch exam attempt পাওয়া যায়নি।");
    return;
  }

  // Group attempts by examId
  const examMap = new Map(); // examId -> { participants: Set<name>, latestTime: Date }

  for (const d of batchSnap.docs) {
    const f = d.data();
    const examId = (f.examId || "").trim();
    const name   = (f.guestName || "").trim();
    if (!examId || !name) continue;

    const submittedAt = f.submittedAt?.toDate?.() ?? new Date(0);

    if (!examMap.has(examId)) {
      examMap.set(examId, { participants: new Set(), latestTime: submittedAt });
    }
    const exam = examMap.get(examId);
    exam.participants.add(name);
    if (submittedAt > exam.latestTime) exam.latestTime = submittedAt;
  }

  // Sort exams newest-first, take last 3
  const sortedExams = Array.from(examMap.entries())
    .sort((a, b) => b[1].latestTime - a[1].latestTime);

  if (sortedExams.length === 0) {
    console.log("No batch exams found in attempts.");
    return;
  }

  const checkCount = Math.min(3, sortedExams.length);
  const last3      = sortedExams.slice(0, checkCount);

  // All students who ever took a batch exam
  const allStudents = new Set(
    sortedExams.flatMap(([, exam]) => [...exam.participants])
  );

  // Students who participated in at least one of the last 3 exams
  const recent = new Set(
    last3.flatMap(([, exam]) => [...exam.participants])
  );

  // Who missed ALL 3 recent exams (consecutive miss)
  const missed = [...allStudents].filter(name => !recent.has(name)).sort();

  if (missed.length === 0) {
    await sendMessage(`✅ সবাই গত ${checkCount}টা batch exam-এর অন্তত একটায় অংশ নিয়েছে।`);
    return;
  }

  let msg = `⚠️ <b>Batch Exam Miss Alert</b>\n`;
  msg    += `━━━━━━━━━━━━━━━\n`;
  msg    += `নিচের শিক্ষার্থীরা টানা <b>${checkCount}টা batch exam</b> miss করেছে:\n\n`;
  missed.forEach((name, i) => { msg += `${i + 1}. ${name}\n`; });
  msg    += `\n━━━━━━━━━━━━━━━\n`;
  msg    += `📌 নিয়মিত পরীক্ষায় অংশ নাও — exammatebd.com`;

  await sendMessage(msg);
  console.log(`Warned ${missed.length} students for missing ${checkCount} consecutive batch exams.`);
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

const mode = process.argv[2];
if (mode === "--warn-misses") {
  warnBatchMisses().catch(console.error);
} else if (mode === "--batch-stats") {
  batchStats().catch(console.error);
} else {
  main().catch(console.error);
}
