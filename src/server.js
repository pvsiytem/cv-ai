import express from "express";
import multer from "multer";
import bodyParser from "body-parser";
import fs from "fs";
import pdf from "pdf-parse";
import Groq from "groq-sdk";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getEmbeddings } from "./fastembed-wrapper.js";

const app = express();
app.use(bodyParser.json());

const upload = multer({ dest: "src/uploads/" });
const COLLECTION = "user_docs";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });

const qdrant = new QdrantClient({ url: QDRANT_URL });

// In-memory job queue
const jobs = {}; // { job_id: { status, result } }

// helper: extract PDF text
async function extractText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

// helper: chunk text
function chunkText(text) {
  return text
    .split(/\n\s*\n/)       // split on empty lines
    .map(t => t.trim())
    .filter(t => t.length > 100 && t.length < 2000);  // keep reasonable sizes
}


/* ---------------------- UPLOAD --------------------------- */
app.post("/upload", upload.array("files", 2), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded" });

    const docs = [];
    for (const f of files) {
      const text = await extractText(f.path);
      const chunks = chunkText(text);
      docs.push({ filename: f.originalname, chunks });
    }

    const flat = docs.flatMap(d => d.chunks.map((c, idx) => ({ source: d.filename, text: c, idx })));
const texts = flat.map(x => x.text);
const batchSize = 25;
const embeddings = [];

for (let i = 0; i < texts.length; i += batchSize) {
  const batch = texts.slice(i, i + batchSize);
  const result = await getEmbeddings(batch);
  embeddings.push(...result);
}
await qdrant.recreateCollection(COLLECTION, {
  vectors: {
    size: embeddings[0].length,
    distance: "Cosine"
  }
});


await qdrant.upsert(COLLECTION, {
  points: flat.map((item, i) => ({
    id: i + 1,
    vector: embeddings[i],
    payload: { source: item.source, text: item.text, idx: item.idx }
  }))
});

    res.json({
      message: "Uploaded and embedded",
      files: files.map(f => f.originalname),
      total_chunks: flat.length
    });

  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ EVALUATE (AI + RAG async) ---------------- */
app.post("/evaluate", async (req, res) => {
  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { status: "processing", result: null };

  const { query } = req.body;

  setTimeout(async () => {
    try {
      const [qvec] = await getEmbeddings([query]);
      const hits = await qdrant.search(COLLECTION, {
        vector: qvec,
        limit: 5,
        with_payload: true
      });
      const context = hits.map(h => h.payload.text).join("\n\n");

      const prompt = `
You are an HR evaluator. Compare the candidate CV and the project report.
Use the retrieved context below. Respond with JSON only:
{
 "summary": "",
 "strengths": "",
 "weaknesses": "",
 "score": 0
}

Retrieved context:
${context}
Query: ${query}
`;

      const response = await groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      });

      jobs[jobId] = {
        status: "completed",
        result: response.choices[0].message.content
      };
    } catch (err) {
      jobs[jobId] = { status: "failed", result: err.message };
    }
  }, 2000);

  res.json({ jobId, status: "processing" });
});

/* ---------------------- Check results --------------------- */
app.get("/result/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

app.get("/", (req, res) => res.send("Evaluator running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
