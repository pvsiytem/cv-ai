# .env file 
QDRANT_URL=http://qdrant:6333
PORT=3000
GROQ_API_KEY=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

# How to run
docker compose down
docker compose build --no-cache
docker compose up -d --build
