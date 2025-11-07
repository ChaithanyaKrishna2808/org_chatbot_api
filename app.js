import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { fileURLToPath } from "url";
import multer from "multer";
import { version } from "process";

dotenv.config();

// Helpers for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Environment Variables =====
const HF_API_URL = process.env.HF_API_URL;
const HF_API_KEY = process.env.HF_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME;

// ===== Constants =====
const PORT = process.env.PORT || 5000;

// ===== Express Setup =====
const app = express();
const allowedOrigins = [
  "http://localhost:4200",
  "https://chatbot-ui2808.web.app" // your live Firebase UI domain
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) =>
  res.json({ status: `API is working with ${version}`, time: new Date().toISOString() })
);

// ===== Create HTTP + Socket.IO Server =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
  path: "/socket.io",
});

// ===== In-memory per-user PDF text store =====
const perUserText = new Map(); // socket.id -> PDF text

// ===== File Upload =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Upload API (not mandatory for chat)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid) return res.status(400).json({ error: "Missing sid" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!req.file.mimetype.includes("pdf")) {
      return res.status(415).json({ error: "Only PDF files supported" });
    }

    const parsed = await pdf(req.file.buffer);
    const text = (parsed.text || "").trim();
    if (!text) return res.status(422).json({ error: "Could not extract text" });

    perUserText.set(sid, text.substring(0, 100_000)); // safe limit
    console.log(`📄 PDF uploaded for ${sid}`);
    res.json({ ok: true, sid, pages: parsed.numpages ?? null });
  } catch (err) {
    console.error("❌ Upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ====== Hugging Face helpers ======

// Check if question is related to context
async function isRelatedToContext(question, context = "") {
  try {
    const payload = {
      model: MODEL_NAME,
      messages: [
        {
          role: "system",
          content:
            "You are a classifier. Given a CONTEXT and a QUESTION, reply strictly with YES if the context helps answer it, else NO."
        },
        {
          role: "user",
          content: `CONTEXT:\n${context.slice(0, 4000)}\n\nQUESTION:\n${question}\n\nReply YES or NO only.`
        },
      ],
      stream: false,
    };

    const response = await axios.post(HF_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const result = (response.data?.choices?.[0]?.message?.content || "")
      .trim()
      .toUpperCase();
    return result.startsWith("Y");
  } catch (err) {
    console.error("❌ Relatedness check error:", err.message);
    return false; // assume not related on failure
  }
}

// Answer using PDF context
async function answerFromContext(question, context) {
  try {
    const payload = {
      model: MODEL_NAME,
      messages: [
        {
          role: "system",
          content:
            "Answer using only the provided context. If answer not found, say: I don't have enough information.",
        },
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
      stream: false,
    };

    const response = await axios.post(HF_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || "No response.";
  } catch (err) {
    console.error("❌ Context answer error:", err.message);
    return "Error generating context-based answer.";
  }
}

// General GPT-like answer
async function answerGenerally(question) {
  try {
    const payload = {
      model: MODEL_NAME,
      messages: [
        {
          role: "system",
          content:
            "You are a knowledgeable AI assistant. Answer clearly and concisely.",
        },
        { role: "user", content: question },
      ],
      stream: false,
    };

    const response = await axios.post(HF_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || "No response.";
  } catch (err) {
    console.error("❌ General answer error:", err.message);
    return "Error generating general answer.";
  }
}

// ===== Socket.IO logic =====
io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);

  socket.emit("hello", { sid: socket.id });
  socket.emit(
    "receiveMessage",
    "👋 Hello! You can ask any question directly, or upload a PDF for document-specific answers."
  );

  socket.on("disconnect", () => console.log("❌ Disconnected:", socket.id));

  socket.on("sendMessage", async (msg) => {
    const pdfText = perUserText.get(socket.id);

    // If no PDF uploaded — general answer
    if (!pdfText) {
      const answer = await answerGenerally(msg);
      socket.emit("receiveMessage", answer);
      return;
    }

    // Check if related
    const related = await isRelatedToContext(msg, pdfText);
    const answer = related
      ? await answerFromContext(msg, pdfText)
      : await answerGenerally(msg);

    socket.emit("receiveMessage", answer);
  });

  socket.on("askQuestion", async ({ question }) => {
    const pdfText = perUserText.get(socket.id);
    let answer;
    let source = "general";

    if (pdfText) {
      const related = await isRelatedToContext(question, pdfText);
      if (related) {
        answer = await answerFromContext(question, pdfText);
        source = "document";
      } else {
        answer = await answerGenerally(question);
      }
    } else {
      answer = await answerGenerally(question);
    }

    socket.emit("answer", { answer, at: Date.now(), source });
  });
});

// ===== Start Server =====
server.listen(PORT, () => {
  console.log(`🚀 API + Socket.IO running on port ${PORT}`);
});
