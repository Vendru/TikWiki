import "server-only";
import { WIKI_LANG } from "../config";
import { type DrawConfig, type Modo, escolherPorPeso, loadDrawConfig, sortearFonte } from "../draw";
import { type DB, openDb } from "./index";

/**
 * O pool é read-only em produção: um artefato de build, nunca escrito durante
 * um request. Uma conexão só, reaproveitada entre requests.
 */
let handle: DB | undefined;

function db(): DB {
  if (!handle) handle = openDb({ readonly: true });
  return handle;
}

let drawCfg: DrawConfig | undefined;
const draw = () => (drawCfg ??= loadDrawConfig());

export interface PoolArticle {
  pageId: number;
  title: string;
  url: string;
  extract: string | null;
  thumbnailUrl: string | null;
  curatorNote: string | null;
  source: string;
  scoreQuality: number | null;
  scoreSurprise: number | null;
}

interface Row {
  page_id: number;
  title: string;
  url: string;
  extract: string | null;
  thumbnail_url: string | null;
  curator_note: string | null;
  source: string;
  score_quality: number | null;
  score_surprise: number | null;
}

/** Linha com os scores no formato que o sorteio espera. */
interface Candidato extends Row {
  scoreQuality: number | null;
  scoreSurprise: number | null;
}

const paraCandidato = (r: Row): Candidato => ({
  ...r,
  scoreQuality: r.score_quality,
  scoreSurprise: r.score_surprise,
});

const toArticle = (r: Row): PoolArticle => ({
  pageId: r.page_id,
  title: r.title,
  url: r.url,
  extract: r.extract,
  thumbnailUrl: r.thumbnail_url,
  curatorNote: r.curator_note,
  source: r.source,
  scoreQuality: r.score_quality,
  scoreSurprise: r.score_surprise,
});

const COLUMNS = `page_id, title, url, extract, thumbnail_url, curator_note, source,
                 score_quality, score_surprise`;

export interface RandomOptions {
  lang?: string;
  /** page_ids já vistos na sessão, para não repetir. */
  exclude?: number[];
  mode?: Modo;
  /** Slug do tópico, quando o usuário filtrou. */
  topic?: string;
}

/**
 * No modo surpresa, só entram artigos com audiência medida.
 *
 * Sem o dado não há surpresa a afirmar, e tratar o nulo como zero inverteria
 * o ranking: um artigo de qualidade alta e audiência desconhecida ganharia de
 * todos os que foram medidos e penalizados.
 */
const exigeSurpresa = (modo: Modo) => modo === "surprise";

/** Faixa de rowid por fonte, medida uma vez por processo. */
const faixas = new Map<string, { min: number; max: number; n: number }>();

function faixaDe(lang: string, source: string, comSurpresa: boolean) {
  const chave = `${lang}|${source}|${comSurpresa}`;
  if (!faixas.has(chave)) {
    const r = db()
      .prepare(
        `SELECT MIN(rowid) min, MAX(rowid) max, COUNT(*) n FROM articles
          WHERE lang = ? AND source = ?${comSurpresa ? " AND score_surprise IS NOT NULL" : ""}`,
      )
      .get(lang, source) as { min: number | null; max: number | null; n: number };
    faixas.set(chave, {
      min: r.min ?? 0,
      max: r.max ?? 0,
      n: r.n,
    });
  }
  return faixas.get(chave)!;
}

/** Quantos artigos elegíveis cada fonte tem, no modo pedido. */
function elegiveisPorFonte(lang: string, comSurpresa: boolean): Map<string, number> {
  const linhas = db()
    .prepare(
      `SELECT source, COUNT(*) n FROM articles
        WHERE lang = ?${comSurpresa ? " AND score_surprise IS NOT NULL" : ""}
        GROUP BY source`,
    )
    .all(lang) as { source: string; n: number }[];
  return new Map(linhas.map((l) => [l.source, l.n]));
}

const contagens = new Map<string, Map<string, number>>();
function elegiveis(lang: string, comSurpresa: boolean) {
  const chave = `${lang}|${comSurpresa}`;
  if (!contagens.has(chave)) contagens.set(chave, elegiveisPorFonte(lang, comSurpresa));
  return contagens.get(chave)!;
}

/**
 * Sorteia um artigo do pool.
 *
 * O sorteio é em duas etapas. Primeiro a fonte, pelos pesos de produto: a
 * lista de Artigos peculiares é 3,3% do pool e concentra o melhor conteúdo, e
 * sem esse passo ela apareceria em 3 de cada 100 sorteios. Depois o artigo
 * dentro da fonte, tirando candidatos uniformemente por rowid e escolhendo
 * entre eles com peso — o que pondera de verdade sem travar no topo, e sem
 * varrer as 125 mil linhas a cada request.
 */
export function randomArticle(opts: RandomOptions = {}): PoolArticle | undefined {
  const lang = opts.lang ?? WIKI_LANG;
  const modo: Modo = opts.mode ?? "mixed";
  const cfg = draw();
  const comSurpresa = exigeSurpresa(modo);

  const exclude = new Set(
    (opts.exclude ?? []).filter((n) => Number.isInteger(n)).slice(0, 200),
  );

  // Com filtro de tópico o sorteio por rowid não serve: o tópico não é denso
  // na tabela. Aí a consulta é direta, e o custo é do índice de junção.
  if (opts.topic) return porTopico(lang, opts.topic, modo, exclude, cfg, comSurpresa);

  const fonte = sortearFonte(elegiveis(lang, comSurpresa), cfg);
  if (!fonte) return undefined;

  const faixa = faixaDe(lang, fonte, comSurpresa);
  if (faixa.n === 0) return undefined;

  const porRowid = db().prepare(
    `SELECT ${COLUMNS} FROM articles
      WHERE rowid = ? AND lang = ? AND source = ?${
        comSurpresa ? " AND score_surprise IS NOT NULL" : ""
      }`,
  );

  // Tira candidatos por rowid sorteado. Buracos deixados por remoção fazem
  // tentativas caírem no vazio, e sortear de novo mantém a uniformidade que
  // um 'rowid >= ?' quebraria.
  //
  // O orçamento de tentativas acompanha a densidade do que é elegível: no
  // modo surpresa só 8,8% do "Você sabia?" tem audiência medida, e um teto
  // fixo entregava 6 candidatos em vez de 24, o que enfraquece a ponderação
  // justamente no modo que mais depende dela. Cada tentativa é uma busca por
  // índice, então esticar o teto custa microssegundos.
  const largura = faixa.max - faixa.min + 1;
  const densidade = Math.max(faixa.n / largura, 0.01);
  const tentativas = Math.min(
    Math.ceil((cfg.candidatos / densidade) * 1.5),
    cfg.candidatos * 100,
  );

  const candidatos: Row[] = [];
  for (let i = 0; i < tentativas && candidatos.length < cfg.candidatos; i++) {
    const alvo = faixa.min + Math.floor(Math.random() * largura);
    const row = porRowid.get(alvo, lang, fonte) as Row | undefined;
    if (row && !exclude.has(row.page_id)) candidatos.push(row);
  }

  const escolhido = escolherPorPeso(candidatos.map(paraCandidato), modo, cfg);
  if (escolhido) return toArticle(escolhido);

  // Fonte pequena demais, ou exclusões cobrindo quase tudo. Aqui a varredura
  // vale a pena porque é o caso raro — mas ela ainda respeita a exclusão:
  // devolver um artigo já visto quando existe outro disponível quebra a
  // promessa do histórico da sessão.
  const filtroSurpresa = comSurpresa ? " AND score_surprise IS NOT NULL" : "";
  if (exclude.size > 0) {
    const buracos = [...exclude].map(() => "?").join(",");
    const row = db()
      .prepare(
        `SELECT ${COLUMNS} FROM articles
          WHERE lang = ?${filtroSurpresa} AND page_id NOT IN (${buracos})
          ORDER BY RANDOM() LIMIT 1`,
      )
      .get(lang, ...exclude) as Row | undefined;
    if (row) return toArticle(row);
  }

  // Só agora, com o pool de fato exaurido pelas exclusões, repetir é melhor
  // que não devolver nada.
  const row = db()
    .prepare(
      `SELECT ${COLUMNS} FROM articles
        WHERE lang = ?${filtroSurpresa}
        ORDER BY RANDOM() LIMIT 1`,
    )
    .get(lang) as Row | undefined;
  return row ? toArticle(row) : undefined;
}

const COLUNAS_A = COLUMNS.split(",")
  .map((c) => `a.${c.trim()}`)
  .join(", ");

/**
 * Quantos artigos cada fonte tem dentro de um tema.
 *
 * Memorizado porque o pool é read-only: sem isso, cada sorteio com filtro de
 * tema pagava um GROUP BY sobre a junção, e a latência triplicava.
 */
const contagensTema = new Map<string, Map<string, number>>();

function contagemPorTema(
  lang: string,
  topic: string,
  comSurpresa: boolean,
  filtro: string,
): Map<string, number> {
  const chave = `${lang}|${topic}|${comSurpresa}`;
  if (!contagensTema.has(chave)) {
    const linhas = db()
      .prepare(
        `SELECT a.source, COUNT(*) n
           FROM articles a
           JOIN article_topics at ON at.lang = a.lang AND at.page_id = a.page_id
           JOIN topics t ON t.id = at.topic_id
          WHERE a.lang = ? AND t.slug = ?${filtro}
          GROUP BY a.source`,
      )
      .all(lang, topic) as { source: string; n: number }[];
    contagensTema.set(chave, new Map(linhas.map((l) => [l.source, l.n])));
  }
  return contagensTema.get(chave)!;
}

/**
 * Sorteio dentro de um tema.
 *
 * O rowid não ajuda aqui, porque o tema não é denso na tabela — mas a escolha
 * da fonte continua valendo. Sem ela o filtro de tema desfazia o principal
 * ganho do sorteio: medido, a lista peculiar caía de 58% para 8% assim que o
 * usuário escolhia um tema.
 */
function porTopico(
  lang: string,
  topic: string,
  modo: Modo,
  exclude: Set<number>,
  cfg: DrawConfig,
  comSurpresa: boolean,
): PoolArticle | undefined {
  const filtro = comSurpresa ? " AND a.score_surprise IS NOT NULL" : "";

  const fonte = sortearFonte(contagemPorTema(lang, topic, comSurpresa, filtro), cfg);
  if (!fonte) return undefined;

  // Sorteia pelo ordinal denso: escolher um número e ir direto pela chave
  // primária, em vez de varrer a fonte inteira e montar uma árvore temporária
  // para o ORDER BY RANDOM(), que custava 129 ms.
  const total = contagemPorTema(lang, topic, false, "").get(fonte) ?? 0;
  if (total === 0) return undefined;

  const porOrdinal = db().prepare(
    `SELECT ${COLUNAS_A}
       FROM topic_index ti
       JOIN articles a ON a.lang = ti.lang AND a.page_id = ti.page_id
      WHERE ti.lang = ? AND ti.source = ? AND ti.ord = ?
        AND ti.topic_id = (SELECT id FROM topics WHERE slug = ?)${filtro}`,
  );

  const candidatos: Row[] = [];
  const tentativas = comSurpresa ? cfg.candidatos * 12 : cfg.candidatos * 2;
  for (let i = 0; i < tentativas && candidatos.length < cfg.candidatos; i++) {
    const row = porOrdinal.get(
      lang,
      fonte,
      Math.floor(Math.random() * total),
      topic,
    ) as Row | undefined;
    if (row) candidatos.push(row);
  }

  const disponiveis = candidatos.filter((r) => !exclude.has(r.page_id));
  if (disponiveis.length) {
    const escolhido = escolherPorPeso(disponiveis.map(paraCandidato), modo, cfg);
    if (escolhido) return toArticle(escolhido);
  }

  // A fonte sorteada esgotou dentro do tema — o que acontece cedo em tema
  // pequeno, e mais cedo ainda no modo surpresa, onde só 12% do pool tem
  // audiência medida. Cair direto no `candidatos` devolvia um artigo já visto,
  // muitas vezes o que está na tela: o botão trocava o artigo por ele mesmo e
  // parecia travado. Antes de repetir, procura no tema inteiro, sem prender o
  // sorteio à fonte que acabou.
  const buracos = exclude.size
    ? ` AND a.page_id NOT IN (${[...exclude].map(() => "?").join(",")})`
    : "";
  const outro = db()
    .prepare(
      `SELECT ${COLUNAS_A}
         FROM articles a
         JOIN article_topics at ON at.lang = a.lang AND at.page_id = a.page_id
         JOIN topics t ON t.id = at.topic_id
        WHERE a.lang = ? AND t.slug = ?${filtro}${buracos}
        ORDER BY RANDOM() LIMIT 1`,
    )
    .get(lang, topic, ...exclude) as Row | undefined;
  if (outro) return toArticle(outro);

  // Só agora, com o tema de fato exaurido, repetir é melhor que não devolver
  // nada — e o app avisa na tela quando nem isso existe.
  const repetido = escolherPorPeso(candidatos.map(paraCandidato), modo, cfg);
  return repetido ? toArticle(repetido) : undefined;
}

export interface Topico {
  slug: string;
  label: string;
  count: number;
}

/** Tópicos disponíveis, com quantos artigos cada um tem. */
export function topics(lang: string = WIKI_LANG): Topico[] {
  return db()
    .prepare(
      `SELECT t.slug, t.label, COUNT(*) count
         FROM topics t
         JOIN article_topics at ON at.topic_id = t.id
         JOIN articles a ON a.lang = at.lang AND a.page_id = at.page_id
        WHERE a.lang = ?
        GROUP BY t.id
        HAVING count > 0
        ORDER BY count DESC`,
    )
    .all(lang) as Topico[];
}

export function poolSize(lang: string = WIKI_LANG): number {
  const r = db()
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE lang = ?`)
    .get(lang) as { n: number };
  return r.n;
}
