import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config";

/**
 * Filtro de exclusão. As regras vêm de config/filters.json — são dados, não
 * código, porque precisam ser calibradas empiricamente contra o relatório do
 * sweep. Fontes curadas não passam por aqui.
 */

export interface FilterConfig {
  minBytes: { value: number };
  minProseRatio: { value: number };
  // Os grupos aceitam também chaves `$…` de documentação, descartadas ao compilar.
  titlePatterns: Record<string, unknown>;
  categoryPatterns: Record<string, unknown>;
  stubPatterns: string[];
  fichaPatterns: string[];
}

export interface CompiledFilters {
  minBytes: number;
  minProseRatio: number;
  title: Array<{ rule: string; patterns: RegExp[] }>;
  category: Array<{ rule: string; patterns: RegExp[] }>;
  stub: RegExp[];
  ficha: RegExp[];
}

/**
 * Compila os grupos de regex, ignorando as chaves iniciadas por `$`.
 *
 * A config usa esse prefixo para o racional de cada regra — o porquê precisa
 * morar junto do padrão, senão a calibração vira folclore. Elas não são
 * regras e não podem entrar na compilação.
 */
const compileGroup = (groups: Record<string, unknown>) =>
  Object.entries(groups)
    .filter(([rule, patterns]) => !rule.startsWith("$") && Array.isArray(patterns))
    .map(([rule, patterns]) => ({
      rule,
      patterns: (patterns as string[]).map((p) => new RegExp(p, "i")),
    }));

export function compileFilters(cfg: FilterConfig): CompiledFilters {
  return {
    minBytes: cfg.minBytes.value,
    minProseRatio: cfg.minProseRatio.value,
    title: compileGroup(cfg.titlePatterns),
    category: compileGroup(cfg.categoryPatterns),
    stub: cfg.stubPatterns.map((p) => new RegExp(p, "i")),
    ficha: cfg.fichaPatterns.map((p) => new RegExp(p, "i")),
  };
}

export function loadFilters(): CompiledFilters {
  const file = path.join(CONFIG_DIR, "filters.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as FilterConfig;
  return compileFilters(raw);
}

/** Tudo que o filtro sabe sobre um candidato. Campos ausentes não reprovam. */
export interface Candidate {
  title: string;
  ns: number;
  bytes: number;
  isDisambiguation?: boolean;
  categories?: string[];
  wikitext?: string;
}

/** Nome da regra que derrubou o candidato, ou undefined se ele passou. */
export type Rejection = string | undefined;

/**
 * Estima a fração do wikitext que é prosa corrida.
 *
 * Remove templates (com aninhamento), tabelas, refs, comentários, arquivos e
 * itens de lista — o que sobra é o texto que uma pessoa realmente lê. Um
 * artigo-ficha tem prosa perto de zero mesmo tendo muitos bytes.
 */
export function proseRatio(wikitext: string): number {
  if (!wikitext.trim()) return 0;

  let s = wikitext;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*\/>/gi, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");

  // Templates, das folhas para fora.
  let previous: string;
  do {
    previous = s;
    s = s.replace(/\{\{[^{}]*\}\}/g, "");
  } while (s !== previous);

  // Tabelas, também aninhadas.
  do {
    previous = s;
    s = s.replace(/\{\|(?:(?!\{\||\|\})[\s\S])*\|\}/g, "");
  } while (s !== previous);

  s = s.replace(/\[\[(?:File|Image|Arquivo|Ficheiro|Category|Categoria):[^\]]*\]\]/gi, "");
  // Linhas de lista, cabeçalhos de seção e o rodapé de links.
  s = s.replace(/^[*#:;].*$/gm, "");
  s = s.replace(/^=+.*=+\s*$/gm, "");

  const prose = s.replace(/\s+/g, " ").trim().length;
  return prose / wikitext.length;
}

/**
 * Aplica as regras e devolve a primeira que reprovar.
 *
 * A ordem é por custo: as primeiras usam só o que a consulta básica já
 * trouxe, e as últimas dependem do wikitext. Devolver a primeira reprovação
 * (em vez de todas) é o que faz o relatório somar 100% dos descartes.
 */
export function reject(c: Candidate, f: CompiledFilters): Rejection {
  if (c.ns !== 0) return "namespace";
  if (c.isDisambiguation) return "desambiguacao_pageprop";
  if (c.bytes < f.minBytes) return "bytes_minimo";

  for (const { rule, patterns } of f.title) {
    if (patterns.some((p) => p.test(c.title))) return `titulo:${rule}`;
  }

  if (c.categories?.length) {
    for (const { rule, patterns } of f.category) {
      if (c.categories.some((cat) => patterns.some((p) => p.test(cat)))) {
        return `categoria:${rule}`;
      }
    }
  }

  if (c.wikitext) {
    if (f.stub.some((p) => p.test(c.wikitext!))) return "esboco";

    const ratio = proseRatio(c.wikitext);
    if (ratio < f.minProseRatio) {
      // Distingue no relatório a ficha reconhecida do artigo genericamente
      // sem prosa: são calibrações diferentes.
      return f.ficha.some((p) => p.test(c.wikitext!))
        ? "ficha_sem_prosa"
        : "prosa_insuficiente";
    }
  }

  return undefined;
}

/** Contador de descartes por regra, para o relatório de calibração. */
export class RejectionReport {
  private readonly counts = new Map<string, number>();
  private total = 0;
  private passed = 0;

  record(rejection: Rejection): void {
    this.total++;
    if (!rejection) {
      this.passed++;
      return;
    }
    this.counts.set(rejection, (this.counts.get(rejection) ?? 0) + 1);
  }

  get summary() {
    return {
      total: this.total,
      passed: this.passed,
      rejected: this.total - this.passed,
      byRule: [...this.counts.entries()].sort((a, b) => b[1] - a[1]),
    };
  }

  format(): string {
    const { total, passed, byRule } = this.summary;
    if (total === 0) return "  (nenhum candidato avaliado)";
    const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
    const width = Math.max(20, ...byRule.map(([r]) => r.length));
    const lines = byRule.map(
      ([rule, n]) => `  ${rule.padEnd(width)} ${String(n).padStart(6)}  ${pct(n)}`,
    );
    lines.push(`  ${"APROVADOS".padEnd(width)} ${String(passed).padStart(6)}  ${pct(passed)}`);
    return lines.join("\n");
  }
}
