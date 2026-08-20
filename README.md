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

Etapas 1 a 4 concluídas: as três fontes ingeridas, o pool filtrado e pontuado,
e o sorteio ponderado com temas e modos.

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
npm run sample                              # amostra para julgar à mão
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

| fonte | peso | medido |
| --- | --- | --- |
| Artigos peculiares | 50 | 54,5% |
| "Você sabia?" | 45 | 38,0% |
| varredura ampla | 5 | 7,5% |

O efeito no que o usuário vê: numa amostra de 14 artigos sorteados depois da
mudança, eu abriria 9 — "Fart Proudly" de Benjamin Franklin, *Fox tossing*,
*Potoooooooo*, o paradoxo de Grelling–Nelson. Antes eram cerca de 8 em 30.

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
inferência. Cobertura de 71% do pool; os 29% sem tema aparecem no sorteio sem
filtro, que é o padrão.

```bash
npm run topics    # popula os temas, sem tocar na rede
```

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

## Próximas etapas

5. Calibração — a ferramenta existe (`npm run sample`); falta o ciclo de
   ajuste em cima dela, agora que os pesos de sorteio são o que mais move a
   qualidade percebida.

O que ficou por fazer, em ordem de valor:

- **Audiência para o resto do pool.** Só 12% tem, e é o que limita o modo
  surpresa. São 110 mil requests numa API que já recusou tudo por horas.
- **Backlinks.** Medidos em 3,8% do pool, e a ausência custa pouco: 0,943 de
  correlação de postos com o score completo.
- **Temas para os 29% sem cobertura**, que exigiria as categorias de cada
  artigo — cerca de 18.700 requests.
