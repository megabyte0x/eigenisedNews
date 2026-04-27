# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist/bundle.cjs ./bundle.cjs
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "bundle.cjs"]
