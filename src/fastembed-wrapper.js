// src/fastembed-wrapper.js
import { spawn } from "child_process";

/**
 * getEmbeddings(texts: string[]) -> Promise<number[][]>
 * Calls python helper (src/fastembed_helper.py).
 */
export async function getEmbeddings(texts) {
  if (!Array.isArray(texts)) throw new Error("texts must be array");
  return await spawnPythonEmbeddings(texts);
}

function spawnPythonEmbeddings(texts) {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["./src/fastembed_helper.py"], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));

    py.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("python helper failed: " + stderr));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (e) {
        reject(new Error("failed parsing python output: " + e.message));
      }
    });

    // send texts as JSON to python stdin
    py.stdin.write(JSON.stringify(texts));
    py.stdin.end();
  });
}
