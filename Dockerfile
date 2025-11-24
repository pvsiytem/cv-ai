# E:\cv-ai\Dockerfile
FROM node:18-bullseye

# install python3 & pip (required for fastembed helper)
RUN apt-get update && apt-get install -y python3 python3-pip build-essential git && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

# install fastembed and any python deps used by the helper
# note: fastembed will download model artifacts on first run inside container
RUN python3 -m pip install --upgrade pip
RUN python3 -m pip install fastembed

COPY . .

EXPOSE 3000
CMD ["node", "--max-old-space-size=4096", "src/server.js"]
