/**
 * Tratamento do resumo (lead) da Wikipédia.
 *
 * A limpeza é de qualidade de dado e roda na ingestão; o encurtamento é de
 * apresentação e roda na hora de exibir. São coisas diferentes de propósito:
 * o texto completo fica no pool para quem quiser outro corte.
 */

// Faixas de IPA: extensões fonéticas, modificadores e marcas de tonicidade.
const IPA_CHARS = /[ɐ-ʯʰ-˿͜͡]/;
const PRONUNCIATION = /\b(?:pronunciation|pronounced|pronúncia|IPA|listen)\b/i;

/** Um trecho que só carrega ruído de pronúncia. */
function isNoise(inner: string): boolean {
  return IPA_CHARS.test(inner) || PRONUNCIATION.test(inner);
}

/**
 * Filtra o interior de um parêntese segmento a segmento.
 *
 * Leads costumam misturar ruído e conteúdo dentro do mesmo parêntese —
 * `(German pronunciation: [ɪç…]; "I Am a Berliner")` — então descartar o
 * parêntese inteiro jogaria fora a tradução, que é justamente o que interessa.
 */
function filterSegments(inner: string): string {
  const kept = inner
    .split(";")
    .filter((seg) => seg.trim() && !isNoise(seg))
    .map((seg) => seg.trim());
  return kept.join("; ");
}

/**
 * Percorre os parênteses respeitando aninhamento, tratando os de dentro antes
 * dos de fora.
 *
 * Uma regex não dá conta: leads de nomes estrangeiros aninham parênteses
 * ("(TRIS-kə-; do grego τρεισκαίδεκα (treiskaídeka))") e o grupo externo
 * nunca casaria enquanto o interno existisse.
 */
function stripNoiseParens(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "(") {
      out += text[i];
      i++;
      continue;
    }

    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }

    // Parêntese sem fechamento: copia o resto como está.
    if (j >= text.length) {
      out += text.slice(i);
      break;
    }

    const inner = stripNoiseParens(text.slice(i + 1, j));
    if (isNoise(inner)) {
      const kept = filterSegments(inner);
      out += kept ? `(${kept})` : "";
    } else {
      out += `(${inner})`;
    }
    i = j + 1;
  }

  return out;
}

/**
 * Remove do lead o entulho que o extrato em texto puro deixa para trás:
 * transcrições fonéticas e os parênteses vazios ou truncados que sobram
 * quando a API já removeu o conteúdo de dentro deles.
 */
export function cleanExtract(input: string): string {
  // Colchetes de pronúncia saem inteiros; são sempre só a transcrição.
  let s = input.replace(/\[([^[\]]*)\]/g, (m, inner: string) =>
    isNoise(inner) ? "" : m,
  );

  s = stripNoiseParens(s);

  // As sobras se encavalam: a API entrega coisas como "(, , or )", e cada
  // regra abaixo remove uma camada por passada. Repetir até estabilizar deixa
  // a função idempotente — importante porque o resultado vai para o pool e
  // pode ser relimpo numa reingestão.
  let previous: string;
  do {
    previous = s;

    // Rótulo que perdeu o valor: "(German:, 'The Bell')" vira "('The Bell')".
    // Só casa quando os dois-pontos são seguidos direto de separador ou fecha,
    // então "(Latin: aqua)" fica intacto.
    s = s.replace(/\(\s*[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{0,30}:\s*[,;]\s*/g, "(");
    s = s.replace(/\(\s*[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{0,30}:\s*\)/g, "");

    // Sobras de separador quando um item interno some: "(, X)" ou "(; X)".
    s = s.replace(/\(\s*[,;:]\s*/g, "(");
    s = s.replace(/\s*[,;:]\s*\)/g, ")");

    // Parêntese que sobrou só com um conectivo: "(or)" não diz nada.
    s = s.replace(/\(\s*(?:or|and|ou|e)\s*\)/gi, "");

    // Parênteses que ficaram vazios.
    s = s.replace(/\(\s*\)/g, "");
    s = s.replace(/\[\s*\]/g, "");

    // Espaço antes de pontuação, só quando ela de fato encerra o trecho.
    // Sem a checagem seguinte, "o operador escrito ?:," viraria "escrito?:,":
    // pontuação também aparece como conteúdo.
    s = s.replace(/[ \t]+([,.;:])(?=\s|$)/g, "$1");
    s = s.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
    s = s.replace(/[ \t]{2,}/g, " ");
    s = s.replace(/\s*\n\s*/g, "\n");
    s = s.trim();
  } while (s !== previous);

  return s;
}

/** Fim de frase seguido de espaço, ignorando abreviações comuns. */
const SENTENCE_END = /[.!?]["')\]]?\s/g;

/**
 * Encurta o lead até caber, cortando em fim de frase.
 *
 * O card existe para o usuário decidir em segundos se quer ler; um lead
 * inteiro pode passar de 2.000 caracteres e vira parede de texto, que é o
 * oposto do loop deliberado de um artigo por vez.
 */
export function summarize(input: string, maxChars = 420): string {
  const text = input.trim();
  if (text.length <= maxChars) return text;

  // Última frase que termina dentro do limite.
  let cut = 0;
  SENTENCE_END.lastIndex = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].trimEnd().length;
    if (end > maxChars) break;
    cut = end;
  }

  // Nenhuma frase inteira coube: corta na última palavra antes do limite.
  if (cut === 0) {
    const slice = text.slice(0, maxChars);
    const space = slice.lastIndexOf(" ");
    return `${(space > 0 ? slice.slice(0, space) : slice).replace(/[,;:]$/, "")}…`;
  }

  return text.slice(0, cut);
}
