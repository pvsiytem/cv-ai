// src/ingest.js
import fs from "fs";
import pdf from "pdf-parse";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getEmbeddings } from "./fastembed-wrapper.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

// Collections
const SYSTEM_COLLECTION = "system_docs";
const USER_COLLECTION = "manual_ingest";

// folders
const systemDir = "src/system";
const uploadDir = "src/uploads";

//PDF read helper
async function readPdf(path) {
  const buffer = fs.readFileSync(path);
  const data = await pdf(buffer);
  return data.text;
}

// simple text chunker
function chunk(text) {
  return text.split(/\n\s*\n/).map(t => t.trim()).filter(t => t.length > 80);
}

// CHUNKIER text chunker 
function chunkLarge(text, size = 800, overlap = 100) {
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

// ingest system documents
async function ingestSystem() {
  const client = new QdrantClient({ url: QDRANT_URL });
  const files = fs.readdirSync(systemDir).filter(f => f.endsWith(".pdf"));

  const docs = [];
  for (const file of files) {
    const text = await readPdf(`${systemDir}/${file}`);
    const chunks = chunk(text);
    const type = file.toLowerCase().includes("project") ? "project" : "cv";
    chunks.forEach((c, i) => docs.push({ text: c, source: file, type, idx: i }));
  }

  const embeddings = await getEmbeddings(docs.map(d => d.text));

  await client.recreateCollection(SYSTEM_COLLECTION, {
    vectors: { size: embeddings[0].length, distance: "Cosine" }
  });

  await client.upsert(SYSTEM_COLLECTION, {
    points: docs.map((d, i) => ({
      id: i + 1,
      vector: embeddings[i],
      payload: { ...d }
    }))
  });

  console.log(`System docs ingested (${docs.length})`);
}

// ingest user uploaded document
async function ingestUser() {
  const client = new QdrantClient({ url: QDRANT_URL });
  const files = fs.readdirSync(uploadDir);

  if (!files.length) {
    console.log("No user file to ingest. Skipping manual_ingest.");
    return;
  }

  const uploadPath = `${uploadDir}/${files[0]}`;
  const text = await readPdf(uploadPath);
  const chunks = chunkLarge(text);

  const embeddings = await getEmbeddings(chunks);

  await client.recreateCollection(USER_COLLECTION, {
    vectors: { size: embeddings[0].length, distance: "Cosine" }
  });

  await client.upsert(USER_COLLECTION, {
    points: chunks.map((c, i) => ({
      id: i + 1,
      vector: embeddings[i],
      payload: { source: files[0], text: c, idx: i }
    }))
  });

  console.log(`User manual ingest complete (${chunks.length} chunks)`);
}

// runs concurrently
async function main() {
  await ingestSystem();
  await ingestUser();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
