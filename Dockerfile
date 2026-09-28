FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY deploy/*.mjs ./deploy/

CMD ["node", "src/index.js"]
