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

// extract PDF text
async function extractText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

// chunk text
function chunkText(text) {
  return text
    .split(/\n\s*\n/)       // split on empty lines
    .map(t => t.trim())
    .filter(t => t.length > 100 && t.length < 2000);  // keep reasonable sizes
}


// UPLOAD ENDPOINT
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

    const jobId = `job_${Date.now()}`;
    jobs[jobId] = { status: "uploaded", chunks: flat, result: null };

    res.json({
      message: "Uploaded and embedded",
      files: files.map(f => f.originalname),
      total_chunks: flat.length,
      jobId
    });

  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ error: err.message });
  }
});


const SYSTEM_COLLECTION = "system_docs"; // new

// retry wrapper
async function retry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

// clean JSON since it was an issue for the evaluate endpoint
function cleanJson(str) {
  return str
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

// EVALUATE ENDPOINT
app.post("/evaluate", async (req, res) => {
  const { jobId } = req.body;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ error: "job not found" });

  jobs[jobId] = { status: "processing", result: null };

  setTimeout(async () => {
    try {
      const texts = job.chunks.map(x => x.text);
      const [qvec] = await getEmbeddings([texts.join(" ")]);

      // RAG retrieval for CV
      const cvHits = await qdrant.search(SYSTEM_COLLECTION, {
        vector: qvec,
        limit: 5,
        with_payload: true,
        filter: { must: [{ key: "type", match: { value: "cv" } }] }
      });

      const cvContext = cvHits.map(h => h.payload.text).join("\n\n");

      // RAG retrieval 2 for Project Report
      const projHits = await qdrant.search(SYSTEM_COLLECTION, {
        vector: qvec,
        limit: 5,
        with_payload: true,
        filter: { must: [{ key: "type", match: { value: "project" } }] }
      });

      const projContext = projHits.map(h => h.payload.text).join("\n\n");

      // CV SCORING FIRST
      const cvPrompt = `
Using retrieved Job Description and CV Rubric context below, evaluate the candidate CV.
Return ONLY valid JSON:
{ "cv_match_rate": "", "cv_feedback": "" }

Context:
${cvContext}
`;

      const cvResp = await retry(() =>
        groqClient.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: cvPrompt }],
          temperature: 0.1
        })
      );

      const cv = cvResp.choices[0].message.content;

      // PROJECT EVALUATION SECOND
      const projPrompt = `
Using retrieved Case Study Brief and Project Rubric context below, evaluate the candidate project.
Return ONLY valid JSON:
{ "project_score": "", "project_feedback": "" }

Context:
${projContext}
`;

      const projResp = await retry(() =>
        groqClient.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: projPrompt }],
          temperature: 0.1
        })
      );

      const proj = projResp.choices[0].message.content;

      // FINAL REPORT 
      const finalPrompt = `
Synthesize CV evaluation + project evaluation.
Return ONLY valid JSON:
{ "overall_summary": "" }

CV: ${cv}
Project: ${proj}
`;

      const finalResp = await retry(() =>
        groqClient.chat.completions.create({
          model: "llama-3.3-70b-versatile", //llamma per recommendation of a friend, but feel free to swap with anything else that's NOT deprecated
          messages: [{ role: "user", content: finalPrompt }],
          temperature: 0.1
        })
      );

      // Parse JSON outputs from model
      const cvJson = JSON.parse(cleanJson(cv));
      const projJson = JSON.parse(cleanJson(proj));
      const summaryJson = JSON.parse(cleanJson(finalResp.choices[0].message.content));

      // save flattened clean structure
      jobs[jobId] = {
        status: "completed",
        result: {
          cv_match_rate: cvJson.cv_match_rate,
          cv_feedback: cvJson.cv_feedback,
          project_score: projJson.project_score,
          project_feedback: projJson.project_feedback,
          overall_summary: summaryJson.overall_summary
        }
      };

    } catch (err) {
      jobs[jobId] = { status: "failed", result: err.message };
    }
  }, 2000);

  res.json({ jobId, status: "processing" });
});



// RESULT ENDPOINT
app.get("/result/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

app.get("/", (req, res) => res.send("Evaluator running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
