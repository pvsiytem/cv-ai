# .env file 
- QDRANT_URL=http://qdrant:6333
- PORT=3000
- GROQ_API_KEY=insertapikeyhere

# How to run
- docker compose down
- docker compose build --no-cache
- docker compose up -d --build

- Npm run dev/build is not needed here since it uses Docker
