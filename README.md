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

As cinco etapas concluídas: as três fontes ingeridas, o pool filtrado e
pontuado, o sorteio ponderado com temas e modos, e o ciclo de calibração.

| Métrica | Valor |
| --- | --- |
| Artigos no pool (`en`) | 125.430 |
| Do "Você sabia?" | 121.101 |
| Da lista de Artigos peculiares | 4.202 |
| Da varredura ampla | 127 |
| Com score de qualidade | 125.430 (100%) |
| Com score de surpresa | 14.948 (12%) |
| `data/pool.db.gz` | 63,2 MB |

## Como rodar

```bash
npm install
npm run dev                # app em http://localhost:3000 (extrai o pool antes)
npm test
npm run typecheck

# pipeline, fora do request
npm run ingest:unusual                      # lista de Artigos peculiares
npm run ingest:dyk                          # arquivo do "Você sabia?"
npm run sweep -- --n=800                    # varredura ampla
npm run enrich -- --no-backlinks --no-pageviews   # métricas em lote, pool inteiro
npm run enrich -- --band=90:99 --no-backlinks     # audiência na faixa que rende
npm run enrich -- --score-only              # repontua sem tocar na rede
npm run prune                               # remove o que as regras atuais reprovam
npm run tidy:notes                          # reaplica a limpeza às notas gravadas
npm run topics                              # popula os temas, sem tocar na rede
npm run sample -- --out=amostra.json        # amostra para julgar à mão
npm run pool:pack                           # gera data/pool.db.gz para versionar
```

A ingestão aceita `--refresh` (ignora o cache em disco) e `--limit=N` (processa
só os N primeiros títulos, para validar rápido).

## Configuração

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `WIKI_LANG` | `en` | Idioma alvo da wiki |
| `WIKI_CONTACT` | URL do repo | Contato no `User-Agent`, exigido pela política de acesso da Wikimedia |
| `WIKI_INTERVAL_MS` | `200` | Intervalo mínimo entre requests |
| `WIKI_MAX_RETRIES` | `8` | Tentativas em 429/5xx antes de desistir |
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
lixo custando 10,7pp a mais de artigo bom.

### Isenção das fontes curadas, por fonte

A especificação isenta as fontes curadas do filtro. Isso vale para a lista de
Artigos peculiares — 4.202 itens escolhidos a dedo — mas não para o arquivo do
"Você sabia?", que tem 121 mil e barra muito mais baixa.

Medido no pool, as regras de título derrubariam **2.443 artigos do DYK**: 1.388
listas como "List of generation III Pokémon", 924 eventos datados como "2005
English cricket season", 110 discografias. Chegavam ao topo do modo surpresa
como delegações olímpicas obscuras.

As mesmas regras derrubariam **23 da lista peculiar**, e ali são escolhas
deliberadas: "1927 Liberian general election" é a eleição mais fraudulenta já
registrada, "2005 United States Grand Prix" é a corrida em que só seis carros
largaram. A regra não distingue essas de uma temporada de rotina; a curadoria
distinguia.

Por isso a isenção é **por fonte** em `config/filters.json`: o DYK responde às
regras de título, a lista peculiar não. O corte de bytes segue isento nas duas
— são 15.133 artigos curtos do DYK, e artigo curto do DYK ainda é bom, que é
justamente o que a isenção existe para proteger.

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

O seletor de tema tem "Surpreenda-me" como padrão, e o de modo começa em
equilibrado. Trocar qualquer um dos dois descarta o artigo já pré-buscado —
ele veio do filtro anterior, e entregá-lo faria o seletor parecer quebrado.

### Rotas

| Rota | O que faz |
| --- | --- |
| `GET /api/random?exclude=&mode=&topic=` | Um artigo, fora os ids já vistos |
| `GET /api/topics` | Temas disponíveis, com a contagem de cada um |

`mode` inválido devolve 400; tema sem artigo devolve 404. Nenhuma rota chama a
API da Wikipédia durante o request.

## Sorteio

O sorteio é em duas etapas, e a primeira é o maior lever de qualidade do
produto.

**Primeiro a fonte**, pelos pesos em `config/draw.json`. A lista de Artigos
peculiares é 3,3% do pool e concentra o melhor conteúdo: sem esse passo ela
apareceria em 3 de cada 100 sorteios. Com os pesos atuais ela fica em torno de
50%, medido em 200 sorteios reais:

| fonte | peso | medido em 250 sorteios |
| --- | --- | --- |
| Artigos peculiares | 60 | 57% |
| "Você sabia?" | 39 | 42% |
| varredura ampla | 1 | 1% |

Os pesos valem nos dois caminhos, com e sem filtro de tema. Sem isso o filtro
desfazia o ganho em silêncio: medido, a lista peculiar caía de 58% para 8%
assim que o usuário escolhia um tema.

**Depois o artigo**, tirando candidatos uniformemente por rowid e escolhendo
entre eles com probabilidade proporcional ao peso. Com um candidato só o
sorteio seria uniforme; com muitos, sairia sempre o mesmo topo, que é o que a
especificação pede para evitar. 24 pondera de verdade sem travar, e custa 24
buscas por índice em vez de varrer 125 mil linhas — o request fica em 5ms.

Os modos mudam o peso: `quality` usa o score de qualidade, `surprise` o de
surpresa, `mixed` mistura os dois. O modo surpresa só sorteia entre os 14.948
artigos com audiência medida, porque sem o dado não há surpresa a afirmar. A
escala de surpresa vai a -62,6, e peso negativo não existe, então ela é
deslocada para um piso antes de virar peso.

Com filtro de tema o sorteio por rowid não serve — o tema não é denso na
tabela — então a consulta passa pelo índice de junção e sobe para ~50ms. O
prefetch mascara isso: o usuário nunca espera.

## Temas

A especificação pedia os rótulos de ML da busca (`articletopic:`), mas eles não
são consultáveis por artigo: a busca devolve artigos por tema, e cruzar isso
com o pool exigiria varrer a wiki inteira. Buscar as categorias de cada artigo
custaria cerca de 18.700 requests, e o filtro de tema é opcional na
especificação.

A saída veio de um dado que já estava no pool: **as subpáginas da lista de
Artigos peculiares são uma taxonomia atribuída à mão pelos curadores**, e
cobrem 100% dos 4.202 artigos da lista. Elas viraram os 14 temas canônicos.
Para as demais fontes o tema é inferido do resumo, que quase sempre diz o que a
coisa é na primeira frase.

`article_topics.score` guarda a diferença: 1 para atribuição humana, 0,5 para
inferência. Cobertura de **78,7%** do pool; os 21,3% sem tema aparecem no
sorteio sem filtro, que é o padrão.

```bash
npm run topics    # popula os temas, sem tocar na rede
```

### Como os padrões foram ampliados

A cobertura saiu de 71% extraindo dos 36 mil artigos sem tema o que eles
**declaram ser** — o substantivo depois de "is a"/"was a" — e transformando os
mais comuns em padrão: `tributary`, `railway station`, `abbey`, `museum`,
`flying ace`, `Paralympic`, `bilateral relations`. Noventa padrões novos.

Três foram descartados na conferência por casarem **menção incidental em vez do
que o artigo é**, que é o modo típico de errar aqui:

| padrão | por que saiu |
| --- | --- |
| `\bprofessor\b` | pegou o ator Peter Capaldi e um arqueólogo |
| `\buniversity\b` | 8.406 artigos, entre eles uma dubladora japonesa |
| `\bparish\b` | pegou "civil parish", que é divisão administrativa |

Outros dois foram estreitados para a forma declarativa pela mesma razão:
`\bbishop\b` casava "Æthelwine, Bishop of Durham" citado de passagem, e
`\bneighborhood\b` casava "neighborhood branch of NYPL".

Numa amostra aleatória de 18 artigos recém-rotulados, **16 estavam certos**. O
erro típico que sobra é do mesmo tipo, com substantivo mencionado de passagem —
aceitável para uma inferência marcada com confiança 0,5, e é por isso que a
marca existe.

## Filtro, score e varredura ampla

```bash
npm run sweep -- --n=800          # sorteia, filtra, mede e grava
npm run enrich                    # mede quem ainda não tem métrica
npm run enrich -- --score-only    # repontua o pool sem tocar na rede
```

O `sweep` roda em funil, na ordem de custo das regras. Cada etapa só processa
quem passou pela anterior, porque a maior parte dos candidatos morre nas regras
baratas e não vale pagar wikitext nem audiência por eles:

| etapa | o que busca | custo |
| --- | --- | --- |
| 1 | tamanho, namespace, desambiguação | 1 request / 20 títulos |
| 2 | categorias, langlinks, imagens | 1 request / 50 títulos |
| 3 | wikitext (esboço, prosa, refs, seções) | 1 request / 20 títulos |
| 4 | backlinks | 1 request / artigo |
| 5 | audiência | 1 request / artigo |

Ao final imprime quantos itens cada regra derrubou — é o instrumento para
calibrar as regras em `config/filters.json` na mão.

### O que a varredura de 800 artigos mostrou

| regra | derrubou |
| --- | --- |
| `bytes_minimo` | 51,9% |
| `prosa_insuficiente` | 16,1% |
| `desambiguacao_pageprop` | 5,4% |
| `titulo:evento_datado` | 2,3% |
| `esboco` | 2,5% |
| `categoria:localidades` | 2,3% |
| demais regras | 3,4% |
| **aprovados** | **16,1%** |

O corte de bytes derrubou 51,9%, contra os 56,1% previstos na calibração — a
previsão se sustentou.

### O limite do filtro

O filtro remove lixo com eficácia, mas **o que sobra é válido e sem graça**, que
não é a mesma coisa que interessante. A varredura aprovou "Welland Canal Bridge
13", "The Leamington Post" e "Transport in Bedford": nenhum é lixo, nenhum é
motivo para abrir o site.

O score piora o quadro em vez de resolver. Ordenado por `score_quality`, o topo
da varredura é "Urban sprawl", "Public administration" e "Croatia–Serbia
relations". A fórmula soma backlinks, langlinks, refs e seções, e essas métricas
medem **peso enciclopédico**, que é quase o oposto de curiosidade: um assunto é
muito linkado justamente por ser fundamental e conhecido.

Para comparar, a lista curada entrega "Bog snorkelling", "52-hertz whale" e
"Toynbee tiles" — vindos de julgamento humano sobre o que é peculiar, sinal que
nenhuma métrica estrutural captura.

Isso está registrado como achado, não como pendência resolvida: mexer nos pesos
não conserta, porque o problema é a escolha das métricas, não a ponderação
delas. Ver "Decisões em aberto".

### Falsos positivos, medidos contra o conjunto-ouro

Os 4.202 artigos da lista curada são artigos comprovadamente interessantes,
aprovados por pessoas. Rodar o filtro contra eles mede o que ele destrói — em
produção esses artigos passam direto, mas uma regra que os derruba derruba
também o artigo equivalente que a varredura encontraria.

O primeiro resultado foi 17,5%, e revelou duas regras largas demais:

| regra | antes | agora |
| --- | --- | --- |
| `titulo:evento_datado` | 68 | 19 |
| `titulo:lista` | 3 | 0 |
| `titulo:discografia_elenco` | 2 | 2 |
| **total fora o corte de bytes** | **73 (1,7%)** | **21 (0,50%)** |

`^\d{4} ` e ` of \d{4}$` matavam "Dancing plague of 1518", "2016 clown
sightings" e "1985 Austrian diethylene glycol wine scandal" — o alvo era a
fatia anual de rotina, não o evento histórico que tem ano no nome. A regra
passou a exigir o ano **e** uma palavra de recorrência. `^Timeline of` matava
"Timeline of the far future", e saiu.

Os 19 restantes são eleições, que a regra deve mesmo pegar. A correção custou
**1 artigo de lixo a mais** numa varredura de 800: as outras regras cobrem o
que a de título pegava demais.

O corte de bytes responde pelo resto (664, 15,8%), que é o trade-off já
escolhido na calibração do limiar, não um defeito novo.

### Calibração dos scores

**Cada termo é normalizado pelo seu p90**, e é isso que faz o peso significar o
que aparenta. Sem a normalização os pesos enganavam: como cada métrica tem
dispersão própria depois do log, o peso nominal não correspondia à influência
real.

| termo | peso | variância antes | variância depois |
| --- | --- | --- | --- |
| backlinks | 3,0 | 29% | 12% |
| langlinks | 2,5 | 8% | 11% |
| refs | 2,0 | 5% | 4% |
| sections | 1,0 | 1% | 1% |
| bytes | 1,0 | 2% | 1% |
| images | 0,5 | 1% | 0% |

`sections` com peso 0,8 respondia por 1% do resultado e `backlinks` correlacionava
0,85 com o score final: na prática a fórmula era "backlinks mais ruído". Com os
pesos somando 10, um artigo no p90 de tudo dá exatamente 100.

**bytes, refs e sections são colineares** — 0,83 entre bytes e sections, 0,78
entre bytes e refs. Somam 4,0 de propósito e não mais, para o comprimento não
ser contado três vezes. `backlinks` e `langlinks` são os sinais mais
independentes e levam o maior peso. `images` leva o menor: `prop=images` conta
também os ícones de template, como `File:Commons-logo.svg`.

**O teto de backlinks subiu de 500 para 2000.** Com 500, 5,7% do pool saturava
e o p99 inteiro valia exatamente 500 — justamente os artigos que o ranking
precisa separar. Agora satura 0,3%, e o custo é baixo porque a paginação para
no teto.

**Bônus de curadoria: 15.** A suposição era que a varredura afogaria os artigos
peculiares e que o bônus existiria para alcançar paridade. É o contrário — os
curados vencem em todos os percentis mesmo sem bônus:

| percentil | curado (sem bônus) | varredura |
| --- | --- | --- |
| p25 | 51,0 | 43,8 |
| p50 | 65,7 | 52,9 |
| p75 | 80,0 | 66,6 |
| p90 | 92,0 | 86,8 |

A lista peculiar também favorece artigo bem desenvolvido, não só estranho.
O bônus então não serve para empatar, e sim para valer o que o score não mede.
15 põe a mediana curada em 80,7, entre o p75 e o p90 da varredura.

**Peso da audiência na surpresa: 10.** Calibrado olhando o topo do ranking a
cada peso:

| peso | topo do ranking |
| --- | --- |
| 3 | "Human", "American Samoa", "Christmas Island" — todos famosos |
| 8 | ainda 3 dos 5 acima de 10 mil visualizações |
| **10** | **"Argel Fuchs", "COVID-19 pandemic in Antarctica"** |
| 12 | "Pakistan Muslim League – Functional" |

Mesmo no joelho o topo é misto: "COVID-19 pandemic in Antarctica" convive com
"FC Slutsk". Nenhum peso conserta isso, porque audiência baixa mede
desconhecimento, não curiosidade — o mesmo limite da seção anterior.

Com esse peso, 49% do pool fica com surpresa negativa. É esperado num score
relativo, mas **o sorteio ponderado da etapa 4 precisa deslocar a escala antes
de usar `score_surprise` como peso**.

> Depois de mexer em qualquer peso, rode `npm run enrich -- --score-only`
> **antes** de medir distribuições. O `enrich` só reescreve as linhas que
> remede, então sem esse passo as estatísticas misturam fórmulas — foi o que
> levou a uma primeira calibração errada do peso da surpresa.

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

## Publicar

O app é read-only: nenhuma escrita, nenhum estado entre requests, nenhuma
chamada de rede durante um request. O que ele precisa é do banco em disco
local. Isso descarta serverless e pede um contêiner.

**Por que não Vercel.** O modelo serverless empacota os arquivos junto com a
função, e `pool.db` tem 207 MB — seriam 207 MB por função, em todo deploy, e a
leitura desse arquivo em cada cold start. O `better-sqlite3` também é nativo e
não roda em edge runtime, e é por isso que as rotas fixam `runtime = "nodejs"`.

```bash
fly launch --no-deploy   # só na primeira vez, para criar o app
fly deploy
```

O `Dockerfile` é de dois estágios. O primeiro instala tudo e roda
`npm run build`, cujo `prebuild` extrai `data/pool.db.gz` para `data/pool.db`.
Com `output: "standalone"` o build monta em `.next/standalone` exatamente o que
o servidor precisa, e o segundo estágio copia só isso mais os estáticos.

Debian e não Alpine de propósito: o `better-sqlite3` tem binário pronto para
glibc, e em musl ele compila do zero a cada build.

### O que o `standalone` corta

| | ingênuo | standalone |
| --- | --- | --- |
| dependências | 474 MB instaladas | **73 MB** rastreadas |
| `.next` | 379 MB (291 de cache de build, 67 de dev) | **1,2 MB** + 612 KB de estáticos |
| pool | 198 MB | 198 MB |
| **camadas do app** | **~1,05 GB** | **~273 MB** |

Sem ele iam junto 45 MB de `sharp` — que este app não usa, porque as imagens
vêm do CDN da Wikimedia por `<img>` puro — e todo o cache de build.

Uma armadilha que custou uma iteração: o rastreamento do Next lê os caminhos
montados em `src/lib/config.ts`, conclui que o diretório inteiro é necessário e
**copiou os 3,9 GB do `.cache` para dentro do standalone**. É a mesma causa do
aviso de "overly broad patterns" que o build sempre imprimiu. O
`outputFileTracingExcludes` no `next.config.ts` fecha isso.

O `server.js` do standalone também sobe mais rápido que a CLI: **"Ready" em
0 ms contra 407 ms** do `next start`, o que importa em plataforma que hiberna.

### O `.dockerignore` não é opcional

| | tamanho |
| --- | --- |
| `.cache` (respostas cruas da API) | 3,9 GB |
| `node_modules` | 617 MB |
| `.git` (guarda várias versões do pool) | 447 MB |
| `data/pool.db` (regerado no build) | 198 MB |
| **contexto que sobra** | **65 MB** |

Sem ele o build manda mais de 5 GB para o daemon antes de começar.

### Os números que definiram o `fly.toml`

Medidos no build de produção:

| | |
| --- | --- |
| memória em repouso | 91 MB |
| memória após 100 requests | 144 MB |
| resposta da API, a quente | 3 ms |
| partida do servidor | "Ready" em 0 ms |

Daí `memory = "512mb"`: 256 MB caberia, mas a folga evita o OOM killer no pico
de subida. `auto_stop_machines` fica ligado porque não há estado a preservar, e
o health check aponta para `/api/topics`, que é a checagem mais barata que ainda
toca o banco — um 200 ali prova que o pool foi extraído e abriu.

### Rodar de graça

O app cabe em plano gratuito, mas o que decide não é a memória (144 MB no pico)
e sim **a hibernação**. Este é um produto de um clique: quem abre o link espera
um artigo, não 50 segundos de máquina acordando. Vale conferir o tempo de
retorno a frio da plataforma antes de escolher, porque é ele que estraga a
primeira impressão — os 273 MB de camadas e a partida em 0 ms ajudam, mas não
compensam uma plataforma que demora a acordar.

Planos gratuitos mudam com frequência; confirme os limites atuais antes de
decidir. O `Dockerfile` é padrão e serve em qualquer plataforma de contêiner,
então trocar de provedor depois não exige mudar o repositório.

### Antes de abrir para o público

- **As imagens vêm do CDN da Wikimedia por hotlink.** É o que a API entrega e é
  aceitável em tráfego normal, mas em escala é carga na infraestrutura deles.
- **`/api/random` não tem limite de taxa.** Cada request é read-only e custa
  11–22 ms, então o risco é baixo — mas é uma rota que qualquer um pode chamar
  em laço, e vale um limite se a plataforma cobrar por request.

## Licença do conteúdo

O texto dos artigos vem da Wikipédia sob CC BY-SA 4.0. O app precisa exibir a
atribuição e o link para o artigo original, como a licença exige.

## Qualidade do pool, medida

Nenhuma métrica sabe o que é curioso, então a única aferição honesta é ler uma
amostra. `npm run sample` imprime o que o card mostraria, com os scores ao
lado, e aceita `--source`, `--mode=quality|surprise` e `--seed` para repetir a
mesma amostra depois de uma mudança.

Lendo 30 artigos sorteados uniformemente do pool, eu abriria cerca de 8. Os
outros são válidos e secos: cantatas de Bach, políticos regionais, dubladores.
A mesma leitura sobre 8 sorteados só da lista de Artigos peculiares deu 8 em 8
— "o maior lago numa ilha num lago numa ilha", "a única monarquia
constitucional marxista-leninista da história, com Elizabeth II como monarca",
"os bungee jumpers originais são de Vanuatu".

Esse contraste é o dado mais importante do pool, e é de julgamento, não de
métrica: a lista peculiar é 3,3% do total e concentra o melhor conteúdo. Com
sorteio uniforme ela aparece em 3 de cada 100 artigos.

Não há classe sistemática a filtrar que resolva isso. Medindo pelo resumo, as
suspeitas somam pouco: espécies e gêneros são 3,4% do pool, igrejas 0,6%,
álbuns 0,7%, políticos 0,5% — 5,9% no total, e várias delas trazem material
bom (*Nepenthes lowii*, a planta carnívora que serve de banheiro para
musaranhos, é uma espécie). O conteúdo seco do "Você sabia?" não tem assinatura
estrutural: a barra da fonte é "um fato interessante sobre um artigo novo", e
isso produz uma faixa ampla de artigos corretos e sem graça.

### Integridade

| verificação | resultado |
| --- | --- |
| títulos ou URLs duplicados | 0 |
| URL malformada | 0 |
| score fora de faixa | 0 |
| sem resumo | 6 (0,00%) |
| sem nota | 177 (0,14%) |
| nota com marcação ou entidade residual | 26 (0,02%) |
| sem imagem | 48.977 (39%) |

## Decisões em aberto

**A fórmula do score é uma proposta, não a especificada.** A baseline não
chegou na especificação, então os pesos em `config/score.json` foram escolhidos
aqui, com o racional de cada termo registrado no próprio arquivo.

**A varredura ampla entrega volume, não curiosidade.** Pelo que a amostra
mostra, o custo-benefício dela é ruim comparado às fontes curadas que ainda não
foram implementadas — em especial o arquivo do "Você sabia?", que é justamente
um acervo de fatos curiosos selecionados por pessoas. Vale considerar
implementá-lo antes de investir mais na varredura.

**Tamanho do `data/pool.db`.** Hoje são ~7 MB. A varredura ampla em escala pode
levar o pool a centenas de MB, e cada reingestão vira um blob novo no histórico
do git.

## Calibração

```bash
npm run sample                              # lê uma amostra
npm run sample -- --out=amostra.json        # grava a amostra para julgar
npm run sample -- --judge=amostra.json      # mede o que você julgou
```

Use `--out` em vez de redirecionar o stdout. O `npm run` escreve duas linhas de
cabeçalho antes da saída do script, e com `>` elas entram no arquivo e quebram o
JSON. (`npm run --silent` também resolve, mas é fácil esquecer o `--silent`; o
`--judge` descarta o cabeçalho se ele aparecer.)

A amostra sai **pelo mesmo caminho do app**: os pesos por fonte, os modos e o
filtro de tema valem ali igual. Amostrar o banco direto mostraria uma
distribuição que o usuário nunca vê, e calibrar contra ela seria calibrar a
coisa errada.

O ciclo é: gerar a amostra em JSON, marcar `"bom": true` ou `false` em cada
item, e rodar `--judge`. Ele devolve a taxa de acerto total e por fonte, que é
o que diz qual peso mexer.

### As três rodadas

Critério em todas: "eu abriria este artigo?".

| rodada | pesos | total | Artigos peculiares | "Você sabia?" | varredura |
| --- | --- | --- | --- | --- | --- |
| 1ª, 40 artigos | 50/45/5 | 25/40 = 63% | 21/21 = 100% | 4/18 = 22% | 0/1 |
| 2ª, 30 artigos | 60/39/1 | 23/30 = 77% | 18/18 = 100% | 5/12 = 42% | — |
| 3ª, 40 artigos | 70/29/1 | 27/40 = 68% | 21/24 = 88% | 5/14 = 36% | 1/2 |
| **juntas** | | **75/110 = 68%** | **60/63 = 95,2%** | **14/44 = 32%** | **1/3** |

As taxas por fonte são condicionais à fonte, então somam entre rodadas mesmo
tendo saído de pesos diferentes.

**Os 100% da lista peculiar eram sorte.** Duas rodadas seguidas de 39/39 são
compatíveis com uma taxa real de 95%, e a terceira trouxe 88%. Com 63 casos a
estimativa honesta é **95,2%, IC 95% [87%, 98%]** — e foi ela que derrubou a
previsão de 79% para 76%.

**O modelo não quebrou.** Ele prevê a taxa total a partir das taxas por fonte e
da **composição realmente sorteada**, que varia em torno dos pesos. A amostra da
3ª rodada saiu 60/35/5 em vez de 70/29/1:

| rodada | previsto | observado |
| --- | --- | --- |
| 1ª | 64% | 63% |
| 2ª | 70% | 77% |
| 3ª | 70% | 68% |

O gargalo continua sendo o "Você sabia?", com 32% em 44 casos.

**Não subir mais o peso.** 80/19/1 preveria 83% e 90/9/1 preveria 89%, e não é
para fazer isso. Cada dez pontos de peso compram sete de acerto e cobram
variedade: a 90/9/1 o produto vira a lista peculiar com um fio de ruído, os 121
mil artigos do "Você sabia?" deixam de existir na prática, e 4.202 artigos
esgotam em 93 sessões. Perseguir a métrica até o fim entrega um número melhor e
um produto pior.

### A nota trocada, achada na 3ª rodada

Dois dos três artigos reprovados da lista peculiar tinham nota em formato de
gancho — "Kyle Larson won the first stock car race he ever competed in?" — que
não é como o curador da lista escreve. A causa estava no upsert: `source` era
protegido quando o artigo já vinha de fonte curada, mas `curator_note` não, e o
gancho do "Você sabia?" sobrescrevia a piada do curador sempre que o artigo
estava nas duas fontes. **129 artigos, 3,1% da lista.**

| | |
| --- | --- |
| curador | "Severed feet keep washing up." |
| o que estava no pool | "Five detached human feet have been discovered on British Columbian beaches since August 2007" |

A nota agora é protegida como o `source`: a primeira fonte curada a reivindicar
o artigo fica dona dela, e a mesma fonte reingerindo continua podendo corrigi-la.
As 129 foram restauradas — zero divergências contra a lista real.

Com n=3 não dá para afirmar que a nota trocada causou as reprovações, mas o
conserto vale por si: era o melhor conteúdo do pool sendo substituído por texto
pior.

### Por que não deu para resolver com filtro

A saída melhor seria subir a taxa do "Você sabia?" por regra de exclusão: valeria
para o pool inteiro e não custaria variedade. Foi tentada primeiro, com os sete
reprovados da segunda rodada, e não existe.

**Piso de score não serve — funcionaria ao contrário.** Os reprovados têm
mediana de qualidade **78,7 contra 71,1 da fonte**, e três estão no quartil de
cima:

| reprovado | score | percentil na fonte |
| --- | --- | --- |
| Agriculture in Wales | 91,5 | p85 |
| Fort Srebrna Góra | 86,9 | p80 |
| Andreyan Zakharov | 82,7 | p74 |
| Fleetwood, Oregon | 78,7 | p66 |
| The Lost Homestead | 65,2 | p35 |
| Co-operative Commission | 63,2 | p30 |
| Prince Edward Point Bird Observatory | 62,5 | p29 |

Um piso preservaria justamente os chatos. O score mede desenvolvimento
enciclopédico, e um assunto sem graça pode ser muito bem desenvolvido.

**Filtro por forma de título também não serve.** As duas formas óbvias tiradas
dos reprovados levam junto o melhor da lista peculiar:

| regra | derruba no pool | derruba da lista peculiar | vítimas |
| --- | --- | --- | --- |
| lugar, `X, Região` | 4.170 | 79 | Santa Claus, Arizona · Toadsuck, Texas · Aoshima, Ehime |
| panorama, `X in Y` | 2.735 | 100 | Crime in Antarctica |

Os sete reprovados **não são lixo**: são artigos legítimos, bem escritos, sobre
assuntos comuns. Nenhum sinal estrutural separa "correto e sem graça" de
"correto e fascinante" — que é a mesma conclusão da seção anterior, agora
confirmada numa amostra independente.

Sem filtro possível, sobra a reponderação, e foi ela: **70/29/1**, verificada em
600 sorteios (68,3% / 30,5% / 1,2%). Prevê 79% contra os 72% de 60/39/1. Custa
esgotar a lista peculiar em 120 sessões de 50 em vez de 140.

Setenta artigos, dois julgamentos: serve para mover os pesos na direção certa,
não para afirmar a taxa com precisão.

## O que ficou por fazer

Em ordem de valor. As três valiam mais antes da reponderação para 70/29/1 — vale
reler o porquê antes de gastar horas de rede em qualquer uma.

- **Temas para os 21,3% que sobraram.** É cauda longa: os 42 substantivos mais
  comuns entre os sem tema cobriam só 5 mil dos 36 mil, e os padrões já
  aplicados pegaram 10 mil. O resto exigiria as categorias de cada artigo, e
  cada padrão novo precisa da mesma conferência de precisão — o modo de errar
  aqui é casar menção de passagem.
- **Audiência para o resto do pool** — *hoje vale menos do que parecia*. A
  cobertura por fonte é o que importa, não a total:

  | fonte | audiência medida | peso no sorteio |
  | --- | --- | --- |
  | Artigos peculiares | **100%** (4.202/4.202) | 70% |
  | "Você sabia?" | 8,8% (10.620/121.101) | 29% |
  | varredura ampla | 100% (127/127) | 1% |

  A fonte que domina o sorteio já está completa. Os 110 mil que faltam são
  todos do "Você sabia?", que responde por 29% dos sorteios e acerta 30% — seis
  horas de rede para ampliar o modo surpresa dentro da fonte mais fraca.
- **Backlinks.** Medidos em 3,8% do pool, e a ausência custa pouco: 0,943 de
  correlação de postos com o score completo. Continua não valendo.
