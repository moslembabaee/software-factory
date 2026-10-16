FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
# Roadmap + roadmap_store are repo-root files the API resolves via repositoryRoadmap()
COPY roadmap_store.py ROADMAP.json ROADMAP.md ROADMAP.json.lock ./

# The workspace entry points are TypeScript, so keep the shared tsx runtime.
RUN npm ci

ENV NODE_ENV=production
ENV PORT=3003

USER node
EXPOSE 3003

CMD ["node", "--import", "tsx", "apps/api/src/dev.ts"]
