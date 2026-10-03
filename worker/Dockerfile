FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-opencv python3-pil poppler-utils fonts-dejavu \
  && python3 -m pip install --break-system-packages --no-cache-dir gallery-dl==1.32.14 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV WORKER_TMP_DIR=/tmp/tradumanga

CMD ["npm", "run", "worker"]
