/**
 * Limpeza de wikitext para as notas escritas à mão pelos curadores.
 * Não é um parser completo de MediaWiki — cobre o que aparece nessas listas.
 */
export function stripWikitext(input: string): string {
  let s = input;

  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*\/>/gi, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");

  // Templates aninhados: remove das folhas para fora até estabilizar.
  let previous: string;
  do {
    previous = s;
    s = s.replace(/\{\{[^{}]*\}\}/g, "");
  } while (s !== previous);

  // [[Alvo|Rótulo]] fica com o rótulo; [[Alvo]] fica com o alvo.
  s = s.replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  // [http://url rótulo] fica com o rótulo.
  s = s.replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, "$1");
  s = s.replace(/\[(?:https?:)?\/\/\S+\]/g, "");

  s = s.replace(/'{2,}/g, "");
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Atributos de célula de wikitable que precedem o conteúdo.
 *
 * Uma célula pode trazer formatação antes do texto — `| width="70%" | texto` —
 * e quem lê a partir do primeiro `|` leva os atributos junto.
 */
const CELL_ATTRS =
  /^\s*(?:[a-zA-Z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s|]+)\s*)+\|\s*/;

/** Parênteses que se referem à foto que acompanhava a entrada na capa. */
const PICTURED = /\s*\([^)]*\b(?:pictured|imagem|na foto)\b[^)]*\)/gi;

/**
 * Entidades HTML que sobrevivem ao wikitext.
 *
 * Editores escrevem `World War&nbsp;II` para o número não se separar do nome,
 * e isso chega cru ao card. O espaço rígido vira espaço comum: numa nota
 * curta o controle de quebra não compensa carregar um caractere invisível que
 * a normalização de espaços trata de um jeito e a comparação de outro.
 */
const ENTIDADES: Record<string, string> = {
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  hellip: "…",
  times: "×",
  deg: "°",
};

function decodificarEntidades(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (inteiro, corpo: string) => {
    if (corpo[0] === "#") {
      const code = corpo[1]?.toLowerCase() === "x"
        ? Number.parseInt(corpo.slice(2), 16)
        : Number.parseInt(corpo.slice(1), 10);
      // Fora da faixa válida, deixa como está em vez de gerar lixo.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : inteiro;
    }
    return ENTIDADES[corpo.toLowerCase()] ?? inteiro;
  });
}

/**
 * Limpa uma nota escrita à mão, seja da lista peculiar ou de um gancho.
 *
 * Some com o que é andaime da página de origem e não diz nada ao leitor: a
 * formatação da célula e a referência a uma foto que o card não tem.
 */
export function tidyNote(note: string): string {
  let s = decodificarEntidades(note.replace(CELL_ATTRS, ""));
  s = s.replace(PICTURED, "");
  s = s.replace(/\s+([,.;:!?])/g, "$1");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export interface ListEntry {
  title: string;
  /** Descrição escrita pelo curador explicando por que o artigo é peculiar. */
  note?: string;
}

const BOLD_LINK = /'''+\s*(?:\{\{[^{}]*\}\}\s*)*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/;

/** Uma linha de célula que não é delimitador de linha/tabela. */
const isCell = (line: string) =>
  line.startsWith("|") && !line.startsWith("|-") && !line.startsWith("|}");

/**
 * Extrai as entradas curadas de uma subpágina de "Artigos peculiares".
 *
 * As subpáginas usam wikitable onde a primeira célula é o artigo em negrito e a
 * segunda é a nota do curador:
 *
 *   | '''[[Buttered toast phenomenon]]'''
 *   | But only if you're eating at a table.
 *   |-
 *
 * Ignoramos qualquer link que não esteja em negrito: esses são contexto dentro
 * das notas (países, termos), não entradas da lista.
 */
export function parseUnusualList(wikitext: string): ListEntry[] {
  const entries: ListEntry[] = [];
  const seen = new Set<string>();
  const lines = wikitext.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!isCell(line)) continue;

    const match = BOLD_LINK.exec(line);
    if (!match) continue;

    const title = match[1].replace(/_/g, " ").trim();
    if (!title || title.includes("{{")) continue;
    // Links para outros namespaces não são artigos.
    if (/^(File|Image|Category|Template|Wikipedia|Help|Portal|WP):/i.test(title)) {
      continue;
    }

    // A nota pode vir na mesma célula (após ||) ou na linha seguinte.
    let rawNote = "";
    const inline = line.slice(match.index + match[0].length);
    const inlineSplit = inline.indexOf("||");
    if (inlineSplit >= 0) {
      rawNote = inline.slice(inlineSplit + 2);
    } else {
      const next = lines[i + 1]?.trim();
      if (next && isCell(next) && !BOLD_LINK.test(next)) {
        rawNote = next.slice(1);
        i++;
      }
    }

    const note = tidyNote(stripWikitext(rawNote));
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push(note ? { title, note } : { title });
  }

  return entries;
}
