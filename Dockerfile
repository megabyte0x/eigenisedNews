# syntax=docker/dockerfile:1.7

FROM node:25-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY agent-skills ./agent-skills
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:25-alpine
WORKDIR /app
COPY --from=builder /app/dist/bundle.cjs ./bundle.cjs
COPY --from=builder /app/dist/public ./dist/public
COPY --from=builder /app/agent-skills ./agent-skills
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "bundle.cjs"]
