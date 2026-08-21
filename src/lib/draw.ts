import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config";
import type { Modo } from "./modes";

export { MODOS, ehModo, type Modo } from "./modes";

/**
 * Regras do sorteio.
 *
 * Separado do score de propósito: o score é uma propriedade do artigo, o peso
 * de sorteio é uma decisão de produto sobre o que o usuário deve ver. Os dois
 * mudam por motivos diferentes.
 */

export interface DrawConfig {
  porFonte: Record<string, number>;
  candidatos: number;
  modos: Record<Modo, { quality: number; surprise: number }>;
  pisoDoPeso: number;
}

export function loadDrawConfig(): DrawConfig {
  const file = path.join(CONFIG_DIR, "draw.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as DrawConfig;
}

/**
 * Sorteia uma fonte pelos pesos configurados.
 *
 * Só entram as fontes que de fato têm artigos elegíveis: um peso configurado
 * para uma fonte vazia desperdiçaria sorteios, e no modo surpresa a
 * elegibilidade muda, porque só 12% do pool tem audiência medida.
 */
export function sortearFonte(
  disponiveis: Map<string, number>,
  cfg: DrawConfig,
  aleatorio: () => number = Math.random,
): string | undefined {
  const candidatas = [...disponiveis.entries()].filter(
    ([fonte, n]) => n > 0 && (cfg.porFonte[fonte] ?? 0) > 0,
  );
  if (candidatas.length === 0) {
    // Nenhuma fonte configurada tem artigo: cai para qualquer uma que tenha.
    const qualquer = [...disponiveis.entries()].filter(([, n]) => n > 0);
    return qualquer[Math.floor(aleatorio() * qualquer.length)]?.[0];
  }

  const total = candidatas.reduce((s, [f]) => s + cfg.porFonte[f], 0);
  let sorteio = aleatorio() * total;
  for (const [fonte] of candidatas) {
    sorteio -= cfg.porFonte[fonte];
    if (sorteio <= 0) return fonte;
  }
  return candidatas[candidatas.length - 1][0];
}

export interface Pontuado {
  scoreQuality: number | null;
  scoreSurprise: number | null;
}

/**
 * Peso de um artigo no modo pedido.
 *
 * A escala de surpresa tem valores negativos — vai a -62,6 no pool medido — e
 * peso negativo não existe, então o resultado é deslocado para o piso.
 */
export function peso(a: Pontuado, modo: Modo, cfg: DrawConfig): number {
  const mistura = cfg.modos[modo];
  const q = a.scoreQuality ?? 0;
  const s = a.scoreSurprise ?? 0;
  return Math.max(cfg.pisoDoPeso, mistura.quality * q + mistura.surprise * s);
}

/**
 * Escolhe um entre os candidatos, com probabilidade proporcional ao peso.
 *
 * Os candidatos vêm de um sorteio uniforme, e é isso que impede o resultado de
 * travar no topo: a especificação pede sorteio ponderado, mas não "sempre o
 * melhor artigo do pool". Quanto maior o número de candidatos, mais a escolha
 * puxa para os bons; com um só candidato, o sorteio é uniforme.
 */
export function escolherPorPeso<T extends Pontuado>(
  candidatos: T[],
  modo: Modo,
  cfg: DrawConfig,
  aleatorio: () => number = Math.random,
): T | undefined {
  if (candidatos.length === 0) return undefined;

  const pesos = candidatos.map((c) => peso(c, modo, cfg));
  const total = pesos.reduce((s, p) => s + p, 0);
  if (!(total > 0)) return candidatos[Math.floor(aleatorio() * candidatos.length)];

  let sorteio = aleatorio() * total;
  for (let i = 0; i < candidatos.length; i++) {
    sorteio -= pesos[i];
    if (sorteio <= 0) return candidatos[i];
  }
  return candidatos[candidatos.length - 1];
}
