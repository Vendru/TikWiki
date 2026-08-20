/**
 * Modos de sorteio.
 *
 * Módulo à parte, sem nenhum import de Node, porque o componente de cliente
 * precisa destes valores para montar o seletor — e puxar o carregador de
 * config junto levaria `node:fs` para o bundle do navegador.
 */
export const MODOS = ["quality", "surprise", "mixed"] as const;

export type Modo = (typeof MODOS)[number];

export function ehModo(v: string): v is Modo {
  return (MODOS as readonly string[]).includes(v);
}
