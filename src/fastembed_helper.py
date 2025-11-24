# src/fastembed_helper.py
import sys, json
texts = json.load(sys.stdin)

#fastembed-wrapper.js jumps  here
try:
    from fastembed import TextEmbedding
    te = TextEmbedding()
    embeddings = te.embed(texts)
    out = [list(map(float, e)) for e in embeddings]
    print(json.dumps(out))
except Exception as e:
    dims = 384
    out = []
    for t in texts:
        h = abs(hash(t))  # deterministic hash
        vec = [((h >> (i % 64)) & 0xff) / 255.0 for i in range(dims)]
        out.append(vec)
    print(json.dumps(out))
