// src/ingest.js
import fs from "fs";
import { QdrantClient } from "@qdrant/js-client-rest";
import pdf from "pdf-parse";
import { getEmbeddings } from "./fastembed-wrapper.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = "manual_ingest";
const UPLOAD_PATH = "/mnt/data/Audry Angelina Wijaya - CV.pdf"; // your uploaded CV path

async function readPdf(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdf(buffer);
  return data.text;
}

function chunkText(text, size = 800, overlap = 100) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    const chunk = text.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

async function main() {
  const client = new QdrantClient({ url: QDRANT_URL });
  const text = await readPdf(UPLOAD_PATH);
  const chunks = chunkText(text);

  const batchSize = 25;
  const embeddings = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const result = await getEmbeddings(batch);
    embeddings.push(...result);
  }

await client.recreateCollection(COLLECTION, {
  vectors: {
    size: embeddings[0].length,
    distance: "Cosine"
  }
});


  const points = chunks.map((c, i) => ({
    id: i + 1,
    vector: embeddings[i],
    payload: { source: "uploaded_cv", text: c, idx: i }
  }));

await client.upsert(COLLECTION, {
  points: chunks.map((c, i) => ({
    id: i + 1,
    vector: embeddings[i],
    payload: { source: "uploaded_cv", text: c, idx: i }
  }))
});
  console.log("Manual ingest complete. points:", points.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
