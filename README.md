# TikWiki

Entrega um artigo interessante da Wikipédia para ler, opcionalmente filtrado por
tema.

O projeto tem duas metades independentes:

- **Pipeline de ingestão** — coleta, pontua e armazena um pool de artigos bons.
  Roda periodicamente, fora do request.
- **App web** — sorteia do pool pronto. Um request nunca chama a API da
  Wikipédia.

O pool fica em `data/pool.db` (SQLite), commitado como artefato de build e
read-only em produção.

## Estado atual

Etapa 1 concluída: scaffold, schema e ingestão da lista de Artigos peculiares.

| Métrica | Valor |
| --- | --- |
| Artigos no pool (`en`) | 4.202 |
| Com resumo | 4.202 (100%) |
| Com nota do curador | 4.151 (98,8%) |
| Com imagem | 2.514 (59,8%) |
| Tamanho do arquivo | 6,8 MB |

## Como rodar

```bash
npm install
npm run ingest:unusual     # popula data/pool.db
npm test                   # parsing, filtros e schema
npm run typecheck
```

A ingestão aceita `--refresh` (ignora o cache em disco) e `--limit=N` (processa
só os N primeiros títulos, para validar rápido).

## Configuração

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `WIKI_LANG` | `en` | Idioma alvo da wiki |
| `WIKI_CONTACT` | URL do repo | Contato no `User-Agent`, exigido pela política de acesso da Wikimedia |
| `WIKI_INTERVAL_MS` | `200` | Intervalo mínimo entre requests |
| `WIKI_MAX_RETRIES` | `5` | Tentativas em 429/5xx antes de desistir |
| `TIKWIKI_DB` | `data/pool.db` | Caminho do pool |
| `TIKWIKI_CACHE` | `.cache/wiki` | Cache das respostas cruas |

## Pipeline

### Fontes

`config/sources.json` guarda os pontos de partida por idioma. Títulos de
páginas-meta variam por idioma e mudam com o tempo, então nunca são assumidos: a
ingestão confirma o índice via API e, se ele não existir, falha listando
candidatos encontrados na busca em vez de gravar um pool vazio.

As subpáginas da lista também são descobertas via API (`list=allpages`), não
fixadas em código. Subpáginas que viraram redirect são puladas — o conteúdo já
chega pelo alvo.

**Artigos peculiares** (`Wikipedia:Unusual articles`) — o hub só transclui as
subpáginas; o conteúdo está nelas, em wikitables onde a primeira célula é o
artigo em negrito e a segunda é uma descrição escrita à mão pelo curador:

```
| '''[[Buttered toast phenomenon]]'''
| But only if you're eating at a table.
```

Essa nota é guardada em `curator_note`. É um material que a própria Wikipédia
não oferece e vale mais que o resumo automático para decidir se o artigo
interessa.

Ler os links da página com `prop=links` não serve: devolve 7.495 links contra
4.202 entradas reais, porque inclui todo link de contexto dentro das descrições.
Só o negrito marca uma entrada da lista.

Subpáginas excluídas em `config/sources.json`: `/Removed` (entradas rejeitadas
pela curadoria), `/Categories`, `/Questions`, `/Lists` e `/Other pages` (apontam
para categorias, listas e páginas meta, não artigos).

### Acesso à API

Action API (`https://{lang}.wikipedia.org/w/api.php`), com `User-Agent`
descritivo, intervalo mínimo entre requests e retry com backoff exponencial e
jitter em 429/5xx. Um 4xx que não seja 429 falha na hora — não melhora com
retry.

As respostas cruas são cacheadas em disco, então reexecutar a pipeline não
refaz a rede: a ingestão completa dos 4.202 artigos custa 228 requests na
primeira vez e nenhum nas seguintes.

O batching usa lotes de 20 títulos. A Action API aceita 50, mas `prop=extracts`
limita a 20 por request para clientes anônimos, e o resumo vem junto dos
metadados.

## Schema

`articles` tem chave `(lang, page_id)` e índice único em `(lang, title)`. As
métricas cruas (`bytes`, `langlinks`, `backlinks`, `refs`, `images`, `sections`,
`pageviews`), os scores e `topics` já existem no schema; a etapa 1 preenche
`bytes` e o resto fica `NULL` até as etapas seguintes.

O upsert é conservador de propósito: reingerir uma fonte não apaga métricas nem
scores calculados por outra etapa, e uma varredura ampla nunca rebaixa um artigo
que veio de fonte curada.

`ingest_runs` registra cada execução (achados, gravados, descartados) para dar
para saber a idade e a procedência do pool.

## Licença do conteúdo

O texto dos artigos vem da Wikipédia sob CC BY-SA 4.0. O app precisa exibir a
atribuição e o link para o artigo original, como a licença exige.

## Próximas etapas

2. App web mínimo sobre este pool
3. Filtro de exclusão, score e varredura ampla
4. Tópicos e modos de sorteio
5. Script de calibração
