# Imagem do TikWiki.
#
# O pool é artefato de build: o `prebuild` extrai data/pool.db.gz para
# data/pool.db durante a construção, e a imagem final já sobe com o banco
# pronto no disco local. Nada é buscado na rede em tempo de request.
#
# Debian e não Alpine de propósito: o better-sqlite3 é módulo nativo e tem
# binário pronto para glibc; em musl ele compila do zero a cada build.

FROM node:22-slim AS builder
WORKDIR /app

# Só é usado se o binário pronto do better-sqlite3 não servir para esta
# plataforma. Fica no estágio de build e não vai para a imagem final.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Roda o prebuild (extrai o pool) e compila o Next.
RUN npm run build

# tsx, vitest, typescript e tipos não têm o que fazer em produção.
RUN npm prune --omit=dev


FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Sem isto o Next escuta só em localhost e o proxy do Fly não alcança.
ENV HOSTNAME=0.0.0.0

RUN useradd --system --create-home --uid 1001 tikwiki

COPY --from=builder --chown=tikwiki:tikwiki /app/node_modules ./node_modules
COPY --from=builder --chown=tikwiki:tikwiki /app/.next ./.next
COPY --from=builder --chown=tikwiki:tikwiki /app/config ./config
COPY --from=builder --chown=tikwiki:tikwiki /app/package.json ./package.json
COPY --from=builder --chown=tikwiki:tikwiki /app/next.config.ts ./next.config.ts
# Só o banco extraído: o .gz de 66 MB não serve para nada em produção.
COPY --from=builder --chown=tikwiki:tikwiki /app/data/pool.db ./data/pool.db

USER tikwiki
EXPOSE 3000

# Chamada direta ao binário: `npm start` dispararia o ciclo de scripts do npm
# sem necessidade, e um `prestart` futuro rodaria em produção sem querer.
CMD ["./node_modules/.bin/next", "start"]
