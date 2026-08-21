/**
 * Amostra o pool para julgamento à mão, e mede o que você julgou.
 *
 * Nenhuma métrica sabe o que é curioso — está medido e registrado no README —
 * então a única aferição honesta da qualidade é ler uma amostra. O que este
 * script acrescenta ao olho nu é sortear **pelo mesmo caminho do app**: os
 * pesos por fonte, os modos e o filtro de tema valem aqui igual. Amostrar o
 * banco direto mostraria uma distribuição que o usuário nunca vê, e calibrar
 * contra ela seria calibrar a coisa errada.
 *
 * Uso: npm run sample [-- opções]
 *   --n=N          quantos artigos (padrão 30)
 *   --mode=M       quality, surprise ou mixed (padrão, igual ao app)
 *   --topic=SLUG   filtra por tema, como o seletor faria
 *   --json         imprime JSON, para anotar o julgamento em outra ferramenta
 *   --judge=ARQ    lê um arquivo de julgamentos e mede a taxa de acerto
 *
 * O ciclo de calibração é: `npm run sample -- --json > amostra.json`, marcar
 * cada item com "bom": true ou false, e `npm run sample -- --judge=amostra.json`
 * para ver a taxa por fonte e por modo. Mudou um peso em config/draw.json?
 * Repita e compare.
 */
import fs from "node:fs";
import { WIKI_LANG } from "../src/lib/config";
import { type Modo, ehModo } from "../src/lib/modes";
import { poolSize, randomArticle, topics } from "../src/lib/db/pool";

const args = process.argv.slice(2);
const valor = (nome: string) =>
  args.find((a) => a.startsWith(`--${nome}=`))?.split("=")[1];

const n = Number(valor("n") ?? 30);
const topic = valor("topic");
const comoJson = args.includes("--json");
const julgar = valor("judge");

const modeArg = valor("mode") ?? "mixed";
if (!ehModo(modeArg)) {
  console.error(`--mode precisa ser quality, surprise ou mixed`);
  process.exit(1);
}
const mode: Modo = modeArg;

interface Julgado {
  title: string;
  source: string;
  bom?: boolean | null;
}

/** Lê os julgamentos e reporta a taxa de acerto por fonte. */
function relatorio(arquivo: string): void {
  const itens = JSON.parse(fs.readFileSync(arquivo, "utf8")) as {
    mode?: string;
    topic?: string;
    articles: Julgado[];
  };

  const julgados = itens.articles.filter(
    (a) => a.bom === true || a.bom === false,
  );
  if (julgados.length === 0) {
    console.error(
      `Nenhum item julgado em ${arquivo}. Marque "bom": true ou false em cada artigo.`,
    );
    process.exit(1);
  }

  const bons = julgados.filter((a) => a.bom).length;
  console.log(
    `Julgados: ${julgados.length} de ${itens.articles.length}` +
      `${itens.mode ? ` — modo ${itens.mode}` : ""}` +
      `${itens.topic ? `, tema ${itens.topic}` : ""}\n`,
  );
  console.log(
    `TAXA DE ACERTO: ${bons}/${julgados.length} = ${((bons / julgados.length) * 100).toFixed(0)}%\n`,
  );

  const porFonte = new Map<string, { bons: number; total: number }>();
  for (const a of julgados) {
    const e = porFonte.get(a.source) ?? { bons: 0, total: 0 };
    e.total++;
    if (a.bom) e.bons++;
    porFonte.set(a.source, e);
  }

  console.log("fonte      acertos   taxa   participação na amostra");
  for (const [fonte, e] of [...porFonte.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  )) {
    console.log(
      `  ${fonte.padEnd(9)} ${String(e.bons).padStart(3)}/${String(e.total).padEnd(3)}` +
        `  ${((e.bons / e.total) * 100).toFixed(0).padStart(3)}%` +
        `   ${((e.total / julgados.length) * 100).toFixed(0)}%`,
    );
  }

  console.log(
    `\nA participação de cada fonte vem dos pesos em config/draw.json. Se uma\n` +
      `fonte acerta muito mais que as outras, subir o peso dela sobe a taxa\n` +
      `geral — foi assim que a lista peculiar saiu de 3% para metade dos\n` +
      `sorteios.`,
  );
}

if (julgar) {
  relatorio(julgar);
} else {
  // Sorteia pelo caminho do app, inclusive a exclusão, para não repetir dentro
  // da própria amostra.
  const vistos: number[] = [];
  const artigos = [];
  for (let i = 0; i < n; i++) {
    const a = randomArticle({ mode, topic, exclude: vistos });
    if (!a) break;
    vistos.push(a.pageId);
    artigos.push(a);
  }

  if (comoJson) {
    console.log(
      JSON.stringify(
        {
          mode,
          topic: topic ?? null,
          $instrucao: 'Marque "bom": true ou false em cada artigo e rode npm run sample -- --judge=este-arquivo.json',
          articles: artigos.map((a) => ({
            title: a.title,
            source: a.source,
            note: a.curatorNote,
            scoreQuality: a.scoreQuality,
            scoreSurprise: a.scoreSurprise,
            url: a.url,
            bom: null,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    const temasDisponiveis = topics(WIKI_LANG);
    console.log(
      `Amostra de ${artigos.length} — modo ${mode}` +
        `${topic ? `, tema ${topic}` : ""}, de ${poolSize().toLocaleString("pt-BR")} artigos`,
    );
    if (!topic) {
      console.log(
        `Temas: ${temasDisponiveis.map((t) => t.slug).join(", ")}\n`,
      );
    } else {
      console.log("");
    }

    let i = 0;
    for (const a of artigos) {
      const scores = [
        `q=${a.scoreQuality ?? "—"}`,
        `s=${a.scoreSurprise ?? "—"}`,
        a.thumbnailUrl ? "com imagem" : "sem imagem",
      ].join("  ");
      console.log(`${String(++i).padStart(3)}. ${a.title}   [${a.source}]`);
      console.log(`     ${scores}`);
      if (a.curatorNote) console.log(`     ${a.curatorNote}`);
      if (a.extract) console.log(`     ${a.extract.slice(0, 140)}…`);
      console.log("");
    }

    const porFonte = new Map<string, number>();
    for (const a of artigos) porFonte.set(a.source, (porFonte.get(a.source) ?? 0) + 1);
    console.log(
      "Fontes na amostra: " +
        [...porFonte.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([f, c]) => `${f} ${((c / artigos.length) * 100).toFixed(0)}%`)
          .join(", "),
    );
    console.log(
      `\nPara medir em vez de estimar: npm run sample -- --json > amostra.json,` +
        `\nmarque "bom" em cada item e rode npm run sample -- --judge=amostra.json`,
    );
  }
}
