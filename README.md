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

Etapas 1 e 2 concluídas: pipeline da lista de Artigos peculiares, e app web
sorteando desse pool.

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
npm run dev                # app em http://localhost:3000
npm test                   # parsing, limpeza, sorteio e schema
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

### Limite de bytes

`config/filters.json` fixa o mínimo em **6.000 bytes**, calibrado comparando a
distribuição dos 4.202 artigos aprovados pela curadoria com 750 artigos vindos
de `list=random`:

| limiar | corta do aleatório | perde do curado | troca |
| --- | --- | --- | --- |
| 4.000 | 38,1% | 6,0% | 3,3:1 |
| 5.000 | 47,2% | 10,4% | 2,1:1 |
| **6.000** | **56,1%** | **15,8%** | **1,6:1** |
| 8.000 | 66,3% | 26,5% | 0,95:1 |

6.000 é onde a troca marginal vira: passar para 8.000 corta só 10,2pp a mais de
lixo custando 10,7pp a mais de artigo bom. O filtro não se aplica às fontes
curadas, que passam direto.

### Limpeza do resumo

O extrato em texto puro da API chega com entulho — transcrições fonéticas
(`[ɪç bɪn ʔaɪn bɛʁˈliːnɐ]`), parênteses truncados (`(, VOY-nitch)`) e casos já
degenerados na origem (a API devolve `A paternoster (, , or )` literalmente
assim).

`cleanExtract` remove isso e é idempotente: as sobras se encavalam, então as
regras rodam em laço até estabilizar. Parênteses são percorridos por um scanner
que respeita aninhamento, porque uma regex nunca alcançaria o grupo externo
enquanto o interno existisse. A filtragem é por segmento, para que
`(German pronunciation: [ɪç…]; "I Am a Berliner")` perca a transcrição mas
mantenha a tradução.

Sobra 1 artefato em 4.202 (0,02%). As regras são deliberadamente conservadoras:
o lead de "Elvis operator" contém `escrito ?:,`, que parece resíduo e é
conteúdo — regras mais agressivas o corrompiam.

## App web

Uma tela, um artigo por vez. O card traz título, imagem, a nota do curador em
destaque e o lead.

O botão "outro artigo" é o loop principal do produto, então o próximo artigo é
buscado enquanto o atual está na tela: a troca leva **~70ms**, sem estado de
carregamento. O primeiro artigo vem renderizado no servidor, então a página
abre já com conteúdo.

O lead é encurtado para ~420 caracteres cortando em fim de frase. Sem isso o
card chegava a 2.100px de altura no celular — parede de texto que contraria o
loop deliberado de um artigo por vez.

O histórico da sessão fica em `localStorage` e acompanha o request como
`exclude`, para não repetir. Dá para voltar ao anterior, e `←` / `→` / espaço
navegam.

### Rotas

| Rota | O que faz |
| --- | --- |
| `GET /api/random?exclude=1,2,3` | Um artigo, fora os ids já vistos |

`topic` e `mode` entram na etapa 4, junto com o sorteio ponderado por score.
Hoje o sorteio é uniforme: com o pool na casa dos milhares o `ORDER BY RANDOM()`
custa um scan barato, e não vale inventar amostragem que vai ser substituída.

Nenhuma rota chama a API da Wikipédia durante o request.

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

3. Filtro de exclusão, score e varredura ampla
4. Tópicos e modos de sorteio
5. Script de calibração

Na etapa 3 é preciso decidir o que fazer com o tamanho do `data/pool.db`: hoje
são 6,8 MB, mas a varredura ampla pode levar o pool a centenas de MB, e cada
reingestão vira um blob novo no histórico do git.
