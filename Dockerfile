# Node 20+ is what MCP SDK v2 requires; 22 is the current LTS.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
ENTRYPOINT ["node", "src/index.js"]
