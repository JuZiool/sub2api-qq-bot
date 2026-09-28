FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache font-wqy-zenhei
RUN npm ci --omit=dev

COPY src ./src
COPY deploy/*.mjs ./deploy/

CMD ["node", "src/index.js"]
