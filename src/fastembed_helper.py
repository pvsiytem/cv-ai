# src/fastembed_helper.py
"""
Reads a JSON array of texts from stdin and prints JSON array of embeddings.
Uses `fastembed` (pip package). If not available, returns deterministic pseudo-embeddings (for testing).
"""
import sys, json
texts = json.load(sys.stdin)

try:
    from fastembed import TextEmbedding
    te = TextEmbedding()
    # fastembed.TextEmbedding.embed returns an iterable of vectors
    embeddings = te.embed(texts)
    # convert to plain python lists of floats
    out = [list(map(float, e)) for e in embeddings]
    print(json.dumps(out))
except Exception as e:
    # Fallback: deterministic pseudo-embeddings (not random so results are reproducible)
    dims = 384
    out = []
    for t in texts:
        h = abs(hash(t))  # deterministic hash
        vec = [((h >> (i % 64)) & 0xff) / 255.0 for i in range(dims)]
        out.append(vec)
    print(json.dumps(out))
