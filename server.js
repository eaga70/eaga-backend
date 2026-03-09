import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import * as chrono from "chrono-node";

console.log("OPENAI KEY EXISTS:", !!process.env.OPENAI_API_KEY);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =============================
   OPENAI
============================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =============================
   STORAGE
============================= */
const DATA_DIR = process.cwd();
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let memoryStore = loadJSON(MEMORY_FILE, {});

/* =============================
   HELPERS
============================= */
function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function ensureUser(userId) {
  if (!memoryStore[userId]) memoryStore[userId] = [];
}

/* --- RECURRENCE PARSING (PHASE 1) --- */
function parseRecurrence(raw) {
  const s = String(raw || "").toLowerCase();

  if (
    !s.includes("every") &&
    !s.includes("daily") &&
    !s.includes("weekly") &&
    !s.includes("biweekly") &&
    !s.includes("monthly") &&
    !s.includes("yearly") &&
    !s.includes("each ")
  ) {
    return null;
  }

  const dayMap = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  let recurrence = null;

  // Interval like "every 2 weeks"
  const intervalMatch =
    s.match(/\bevery\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/);

  if (intervalMatch) {
    const interval = Number(intervalMatch[1]) || 1;
    const unit = intervalMatch[2];

    if (unit.startsWith("day")) recurrence = { frequency: "daily", interval };
    if (unit.startsWith("week")) recurrence = { frequency: "weekly", interval };
    if (unit.startsWith("month")) recurrence = { frequency: "monthly", interval };
    if (unit.startsWith("year")) recurrence = { frequency: "yearly", interval };
  }

  if (!recurrence) {
    if (s.includes("biweekly") || s.includes("bi-weekly")) {
      recurrence = { frequency: "weekly", interval: 2 };
    }
  }

  if (!recurrence) {
    if (s.includes("daily") || s.includes("every day")) {
      recurrence = { frequency: "daily", interval: 1 };
    }
    if (s.includes("weekly") || s.includes("every week")) {
      recurrence = { frequency: "weekly", interval: 1 };
    }
    if (s.includes("monthly") || s.includes("every month")) {
      recurrence = { frequency: "monthly", interval: 1 };
    }
    if (s.includes("yearly") || s.includes("every year")) {
      recurrence = { frequency: "yearly", interval: 1 };
    }
  }

  // Specific weekdays
  const everyIdx = s.indexOf("every ");
  if (everyIdx !== -1) {
    const tail = s.slice(everyIdx + 6);

    const days = [];
    for (const [name, num] of Object.entries(dayMap)) {
      const re = new RegExp(`\\b${name}\\b`, "g");
      if (re.test(tail)) days.push(num);
    }

    const uniq = [...new Set(days)];
    if (uniq.length > 0) {
      recurrence = { frequency: "weekly", interval: 1, daysOfWeek: uniq };
    }
  }

  if (!recurrence) return null;

  /* ---------- NEW: END CONDITIONS ---------- */

  // "until June 30"
  const untilMatch = s.match(/\buntil\s+(.+)$/);
  if (untilMatch) {
    const parsed = chrono.parse(untilMatch[1]);
    if (parsed.length && parsed[0].start) {
      recurrence.endDateIso = parsed[0].start.date().toISOString();
    }
  }

  // "for 10 times"
  const countMatch =
    s.match(/\bfor\s+(\d+)\s+(times|occurrences)\b/);

  if (countMatch) {
    recurrence.occurrenceCount = Number(countMatch[1]);
  }

  return recurrence;
}

function stripRecurrenceText(raw) {
  return String(raw || "")
    .replace(/\bevery\s+\d+\s+(day|days|week|weeks|month|months|year|years)\b/gi, "")
    .replace(/\bbi-?weekly\b/gi, "")
    .replace(/\bdaily\b/gi, "")
    .replace(/\bweekly\b/gi, "")
    .replace(/\bmonthly\b/gi, "")
    .replace(/\byearly\b/gi, "")
    .replace(
      /\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      ""
    )
    .replace(/\bevery\s+(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b/gi, "")
    .replace(
      /\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi,
      ""
    )
    .replace(/\bon\s+(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)s?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* --- TIME EXTRACTION (VOICE SAFE) --- */
function extractExplicitTime(raw) {
  const wordsToNumbers = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  let s = raw.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();

  for (const [word, num] of Object.entries(wordsToNumbers)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, "g"), String(num));
  }

  s = s.replace(/\bp\s*m\b/g, "pm").replace(/\ba\s*m\b/g, "am");

  let m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;

    if (m[3] === "pm" && hour < 12) hour += 12;
    if (m[3] === "am" && hour === 12) hour = 0;

    return { hour, minute };
  }

  m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    return { hour: Number(m[1]), minute: Number(m[2]) };
  }

  return null;
}

/* =============================
   HEALTH
============================= */
app.get("/health", (_, res) => res.json({ ok: true }));

/* =============================
   CHAT
============================= */
app.post("/chat", async (req, res) => {
  try {
    const { userId, text } = req.body;
    if (!userId || !text) {
      return res.status(400).json({ error: "Missing userId or text" });
    }

    ensureUser(userId);

    const raw = String(text);
    const t = normalize(raw);

    /* ---------- REMINDER: CREATE ---------- */
    if (t.includes("remind me")) {
      const parsed = chrono.parse(raw, new Date(), { forwardDate: true });

      if (!parsed.length || !parsed[0].start) {
        return res.json({
          reply: "Tell me when to remind you. Example: Remind me tomorrow at 9am.",
        });
      }

      const remindAt = parsed[0].start.date();

      const explicitTime = extractExplicitTime(raw);
      if (explicitTime) {
        remindAt.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
      }

      remindAt.setSeconds(0);
      remindAt.setMilliseconds(0);

      // ✅ NEW: detect recurrence
      const recurrence = parseRecurrence(raw);

      let reminderText = raw
        .replace(/^remind me\s+/i, "")
        .replace(parsed[0].text, "")
        .replace(/^\s*to\s+/i, "")
        .trim();

      // ✅ NEW: strip recurrence words from reminder text
      reminderText = stripRecurrenceText(reminderText);

      if (reminderText.length > 0) {
        reminderText = reminderText.charAt(0).toUpperCase() + reminderText.slice(1);
      }

      const spokenTime = remindAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      const spokenDate = remindAt.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      return res.json({
        reply: recurrence
          ? `Okay — I’ll remind you to ${reminderText} (recurring ${recurrence.frequency}).`
          : `Okay — I’ll remind you to ${reminderText} on ${spokenDate} at ${spokenTime}.`,
        reminderIntent: {
          text: reminderText,
          remindAtIso: remindAt.toISOString(),
          recurrence, // ✅ NEW
        },
      });
    }

    /* ---------- TASK: CREATE ---------- */
if (t.startsWith("add task") || t.startsWith("create task")) {
  const parsed = chrono.parse(raw, new Date(), { forwardDate: true });

  let start = null;

  if (parsed.length && parsed[0].start) {
    start = parsed[0].start.date();
  } else {
    start = new Date();
  }

  start.setSeconds(0);
  start.setMilliseconds(0);

  const recurrence = parseRecurrence(raw);

  let title = raw
    .replace(/^add task\s+/i, "")
    .replace(/^create task\s+/i, "");

  if (parsed[0]?.text) {
    title = title.replace(parsed[0].text, "");
  }

  title = stripRecurrenceText(title);
  title = title.replace(/\s+/g, " ").trim();

  if (title.length > 0) {
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  return res.json({
    reply: `Task "${title}" created.`,
    taskIntent: {
      title,
      startIso: start.toISOString(),
      recurrence,
    },
  });
}

    /* ---------- CALENDAR: CREATE ---------- */
    if (t.startsWith("add ") || t.startsWith("schedule ") || t.startsWith("book ")) {
      let start = null;

      const parsed = chrono.parse(raw, new Date(), { forwardDate: true });

      if (parsed.length && parsed[0].start) {
        start = parsed[0].start.date();
      } else {
        start = null;
      }

      if (!start) {
        const explicitTime = extractExplicitTime(raw);
        if (explicitTime) {
          const now = new Date();
          const assumed = new Date();
          assumed.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
          if (assumed.getTime() <= now.getTime()) {
            assumed.setDate(assumed.getDate() + 1);
          }
          start = assumed;
        }
      }

      if (!start) {
        return res.json({
          reply: 'Tell me when to schedule it. Example: Add meeting tomorrow at 3 pm.',
        });
      }

      /* 🔥 IMPORTANT: Always override time if explicitly stated */
      const explicitTime = extractExplicitTime(raw);
      if (explicitTime) {
        start.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
      }

      start.setSeconds(0);
      start.setMilliseconds(0);

      const end = new Date(start.getTime() + 60 * 60 * 1000);

      // ✅ NEW: detect recurrence
      const recurrence = parseRecurrence(raw);

      let title = raw;
      title = title.replace(/^add\s+/i, "");
      title = title.replace(/to my calendar\s+/i, "");
      if (parsed[0]?.text) {
        title = title.replace(parsed[0].text, "");
      }
      title = title.replace(/\bat\b.*$/i, "");
      title = title.replace(/\bon\b.*$/i, "");
      title = title.replace(/\s+/g, " ").trim();

      // ✅ NEW: strip recurrence words from title
      title = stripRecurrenceText(title);

      if (title.length > 0) {
        title = title.charAt(0).toUpperCase() + title.slice(1);
      }

      const spokenTime = start.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      const spokenDate = start.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      return res.json({
        reply: recurrence
          ? `Okay — I scheduled "${title}" (recurring ${recurrence.frequency}).`
          : `Okay — I scheduled "${title}" on ${spokenDate} at ${spokenTime}.`,
        calendarIntent: {
          title,
          startIso: start.toISOString(),
          endIso: end.toISOString(),
          recurrence, // ✅ NEW
        },
      });
    }

    return res.json({ reply: "Sorry, I didn’t catch that." });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =============================
   MEMORY ROUTES
============================= */

// GET memory for user

app.get("/memory/:userId", (req, res) => {
  try {
    const { userId } = req.params;
    ensureUser(userId);

    return res.json({
      memories: memoryStore[userId] || [],
    });
  } catch (err) {
    console.error("Memory GET error:", err);
    return res.status(500).json({ error: "Failed to load memory" });
  }
});

// ADD memory
app.post("/memory/:userId", (req, res) => {
  try {
    const { userId } = req.params;
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing memory text" });
    }

    ensureUser(userId);

    memoryStore[userId].push(text);
    saveJSON(MEMORY_FILE, memoryStore);

    return res.json({ success: true });
  } catch (err) {
    console.error("Memory POST error:", err);
    return res.status(500).json({ error: "Failed to save memory" });
  }
});

// DELETE memory by index
app.delete("/memory/:userId/:index", (req, res) => {
  try {
    const { userId, index } = req.params;
    ensureUser(userId);

    const idx = parseInt(index, 10);

    if (isNaN(idx) || idx < 0 || idx >= memoryStore[userId].length) {
      return res.status(400).json({ error: "Invalid index" });
    }

    memoryStore[userId].splice(idx, 1);
    saveJSON(MEMORY_FILE, memoryStore);

    return res.json({ success: true });
  } catch (err) {
    console.error("Memory DELETE error:", err);
    return res.status(500).json({ error: "Failed to delete memory" });
  }
});

