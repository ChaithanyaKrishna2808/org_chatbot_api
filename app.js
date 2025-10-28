import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

// ✅ Hugging Face API details
const HF_API_URL = process.env.HF_API_URL;
const HF_API_KEY = process.env.HF_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME;

// ✅ Setup Express + Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = 5000;
const PDF_DIR = path.join(process.cwd(), "test", "data");

console.log("🚀 Starting Chatbot Server...");
console.log("📂 Watching PDF directory:", PDF_DIR);

let pdfTexts = {};

// ✅ Function to load all PDFs from folder
async function loadPDFs() {
  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith(".pdf"));
  console.log("📚 Found PDF(s):", files);

  for (const file of files) {
    const filePath = path.join(PDF_DIR, file);
    try {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdf(dataBuffer);
      pdfTexts[file] = pdfData.text.substring(0, 8000); // limit to 8k chars
      console.log(`✅ Loaded: ${file}`);
    } catch (err) {
      console.log(`⚠️ Error reading ${file}: ${err.message}`);
    }
  }
}

await loadPDFs();

// ✅ Helper: Call Hugging Face Chat API
async function askHuggingFace(userMessage) {
  try {
    console.log(`🔹 Sending to Hugging Face: "${userMessage}"`);

    // combine all PDF text
    const contextText = Object.values(pdfTexts).join("\n\n");

    const payload = {
      model: MODEL_NAME,
      messages: [
        { role: "system", content: "You are a helpful AI assistant that answers based on the given context." },
        { role: "user", content: `Context:\n${contextText}\n\nUser question: ${userMessage}` }
      ],
      stream: false
    };

    const response = await axios.post(HF_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json"
      },
    });

    const text = response.data?.choices?.[0]?.message?.content || "No response";
    console.log("🤖 Hugging Face Response:", text);
    return text;
  } catch (err) {
    console.error("❌ Hugging Face API error:", err.response?.data || err.message);
    return `⚠️ Hugging Face API Error: ${err.response?.statusText || err.message}`;
  }
}

// ✅ Socket.io Communication
io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });

  socket.on("sendMessage", async (msg) => {
    console.log("📩 Message from client:", msg);
    const answer = await askHuggingFace(msg);
    console.log("💬 Sending back answer...");
    socket.emit("receiveMessage", `Chatbot: ${answer}`);
  });
});

// ✅ Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
