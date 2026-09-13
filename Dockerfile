FROM node:24-bookworm-slim AS preview
WORKDIR /app
COPY --chown=node:node server/preview-worker.js server/http.js server/domain.js ./server/
USER node
EXPOSE 3001
CMD ["node", "server/preview-worker.js"]

FROM node:24-bookworm-slim AS control
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
USER node
EXPOSE 3000 3001
CMD ["node", "server/index.js"]
