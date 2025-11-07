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
const PDF_DIR = path.join(process.cwd(), "test", "data");

// ===== Express Setup =====
const app = express();
const allowedOrigins = [
  "http://localhost:4200",
  "https://chatbot-ui2808.web.app" // your live Firebase UI domain
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  }
}));

app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.json({ status: "API up", time: new Date().toISOString() }));

// ===== Create HTTP + Socket.IO Server =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
  path: "/socket.io"
});

// ===== Load PDFs =====
let pdfTexts = {};

async function loadPDFs() {
  try {
    if (!fs.existsSync(PDF_DIR)) {
      console.warn(`⚠️ PDF directory not found: ${PDF_DIR}`);
      return;
    }
    const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith(".pdf"));
    console.log("📚 Found PDFs:", files);

    for (const file of files) {
      const filePath = path.join(PDF_DIR, file);
      try {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdf(dataBuffer);
        pdfTexts[file] = pdfData.text.substring(0, 8000); // limit size
        console.log(`✅ Loaded: ${file}`);
      } catch (err) {
        console.log(`⚠️ Error reading ${file}: ${err.message}`);
      }
    }
  } catch (e) {
    console.error("❌ Error loading PDFs:", e.message);
  }
}

await loadPDFs();

// ===== Hugging Face Request =====
async function askHuggingFace(userMessage) {
  try {
    const contextText = Object.values(pdfTexts).join("\n\n");
    const payload = {
      model: MODEL_NAME,
      messages: [
        {
          role: "system",
          content:
            "Answer the user's question briefly and directly using only relevant information. If unknown, reply: 'I don't have enough information.'"
        },
        { role: "user", content: `Context:\n${contextText}\n\nQuestion: ${userMessage}` }
      ],
      stream: false
    };

    const response = await axios.post(HF_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || "No response";
  } catch (err) {
    console.error("❌ Hugging Face API error:", err.response?.data || err.message);
    return "Error contacting Hugging Face API.";
  }
}

// ===== Socket.IO Events =====
io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);

  socket.on("disconnect", () => console.log("❌ Disconnected:", socket.id));

  socket.on("sendMessage", async (msg) => {
    console.log("📩 Received:", msg);
    const answer = await askHuggingFace(msg);
    socket.emit("receiveMessage", answer);
  });

  socket.on("askQuestion", async ({ fileId, question }) => {
    const answer = await askHuggingFace(`${fileId ? `File:${fileId}\n` : ""}${question}`);
    socket.emit("answer", { answer, at: Date.now() });
  });
});

// ===== Start Server =====
server.listen(PORT, () => {
  console.log(`🚀 API + Socket.IO running on port ${PORT}`);
});
