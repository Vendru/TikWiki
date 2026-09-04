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
# Liga a saída standalone só aqui, no build da imagem: o build local não a
# quer, porque ela faria o app servir as cópias que o rastreamento deixa em
# .next/standalone em vez de data/pool.db. Ver o comentário em next.config.ts.
ENV NEXT_STANDALONE=1
# Roda o prebuild (extrai o pool) e compila o Next. Com a saída standalone o
# build já monta em .next/standalone tudo que o servidor precisa: um
# node_modules rastreado de 73 MB (contra 474 MB do instalado), o config/ e o
# pool extraído. Não há o que podar depois.
RUN npm run build


FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# Padrão para rodar a imagem na mão; em produção a plataforma injeta a porta
# dela e o valor daqui é sobrescrito. A Render usa 10000.
ENV PORT=3000
# Sem isto o Next escuta só em localhost e nenhum proxy externo alcança.
ENV HOSTNAME=0.0.0.0

RUN useradd --system --create-home --uid 1001 tikwiki

# O standalone já traz node_modules rastreado, config/, data/pool.db,
# package.json e o server.js. Copiar .next inteiro mandaria junto 291 MB de
# cache de build e 67 MB de artefatos de dev.
COPY --from=builder --chown=tikwiki:tikwiki /app/.next/standalone ./
# Os estáticos ficam de fora do standalone por design e são servidos pelo
# próprio server.js.
COPY --from=builder --chown=tikwiki:tikwiki /app/.next/static ./.next/static

USER tikwiki
EXPOSE 3000

# O server.js do standalone sobe o Next sem passar pela CLI, o que corta o
# tempo de partida — medido, "Ready" em 0 ms contra 407 ms do `next start`.
CMD ["node", "server.js"]
