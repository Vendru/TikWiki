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
  const largura = faixa.max - faixa.min + 1;
  const candidatos: Row[] = [];
  const tentativas = cfg.candidatos * 3;
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

/** Sorteio dentro de um tópico, onde o rowid não ajuda. */
function porTopico(
  lang: string,
  topic: string,
  modo: Modo,
  exclude: Set<number>,
  cfg: DrawConfig,
  comSurpresa: boolean,
): PoolArticle | undefined {
  const linhas = db()
    .prepare(
      `SELECT ${COLUMNS.split(",")
        .map((c) => `a.${c.trim()}`)
        .join(", ")}
         FROM articles a
         JOIN article_topics at ON at.lang = a.lang AND at.page_id = a.page_id
         JOIN topics t ON t.id = at.topic_id
        WHERE a.lang = ? AND t.slug = ?${
          comSurpresa ? " AND a.score_surprise IS NOT NULL" : ""
        }
        ORDER BY RANDOM() LIMIT ?`,
    )
    .all(lang, topic, cfg.candidatos * 2) as Row[];

  const disponiveis = linhas.filter((r) => !exclude.has(r.page_id));
  const escolhido = escolherPorPeso(
    (disponiveis.length ? disponiveis : linhas).map(paraCandidato),
    modo,
    cfg,
  );
  return escolhido ? toArticle(escolhido) : undefined;
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
