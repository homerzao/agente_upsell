# Stage 1: Build client
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Build server
FROM node:22-alpine AS server-build
WORKDIR /app/server
COPY server/package.json ./
RUN npm install
COPY server/ ./
RUN npm run build

# Stage 3: Production
FROM node:22-alpine
WORKDIR /app

COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/package.json ./

# Painel buildado servido pelo Fastify
COPY --from=client-build /app/client/dist ./public

# Migrations rodam no boot
COPY server/src/db/migrations ./migrations

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
