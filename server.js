import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import multer from "multer";
import OpenAI from "openai";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });

console.log("🔥 SERVER STARTING");
console.log("🔑 OPENAI KEY LOADED:", !!process.env.OPENAI_API_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());


app.post("/voice", upload.single("file"), async (req, res) => {
  console.log("==== REQUEST RECEIVED ====");
  console.log("FILE:", req.file);

  if (!req.file) {
    return res.status(400).json({ error: "NO FILE RECEIVED" });
  }

  try {
    const stream = fs.createReadStream(req.file.path);

    const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(req.file.path),
  model: "gpt-4o-transcribe",
});

const text = transcription.text || "";

    const text = transcription.text;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `You are EAGA AI Concierge.\nUser said: ${text}`,
    });

    fs.unlinkSync(req.file.path);

    res.json({
      transcript: text,
      answer: response.output_text,
    });
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
console.error("❌ MESSAGE:", err?.message);
console.error("❌ STACK:", err?.stack);
    res.status(500).json({
  error: "AI FAILED",
  message: err?.message,
});
  }
});

app.post("/summarize", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "No text provided" });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Summarize the following meeting notes.

Return:
- Short summary (bullet points)
- Action items (if any)

Notes:
${text}
`,
    });

    const summary =
  response.output_text ||
  response.output?.[0]?.content?.[0]?.text ||
  "No summary generated.";

res.json({ summary });
  } catch (err) {
    console.error("❌ SUMMARY ERROR:", err);
    res.status(500).json({ error: "Failed to summarize" });
  }
});

app.listen(3000, () => {
  console.log("🚀 Backend running on http://localhost:3000");
});
