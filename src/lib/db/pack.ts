import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dbPath } from "../config";

/**
 * O pool vai para o repositório comprimido.
 *
 * O arquivo cru passa de 200 MB com o pool completo, e o GitHub recusa
 * qualquer arquivo acima de 100 MB no push. O gzip comprime cerca de 3x — é
 * texto — e mantém a propriedade que interessa: o pool continua sendo um
 * artefato de build versionado, read-only em produção.
 */
export const packedPath = () => `${dbPath()}.gz`;

const mtime = (file: string) => fs.statSync(file).mtimeMs;

export async function packPool(): Promise<{ cru: number; comprimido: number }> {
  const origem = dbPath();
  if (!fs.existsSync(origem)) {
    throw new Error(`Pool não encontrado em ${origem}. Rode a ingestão antes.`);
  }
  const destino = packedPath();
  const tmp = `${destino}.${process.pid}.tmp`;

  await pipeline(
    fs.createReadStream(origem),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(tmp),
  );
  fs.renameSync(tmp, destino);

  // Empacotar significa que o cru está em dia, e a data dele passa a dizer
  // isso. Sem essa marca o comprimido nasce mais novo e o build seguinte
  // reextrairia centenas de MB à toa.
  //
  // A marca é derivada do próprio comprimido, um segundo à frente, em vez de
  // `new Date()`: com o relógio, a ordem só se sustenta se ele andar entre as
  // duas escritas, e sob I/O pesado essa janela fecha — o teste de "já está em
  // dia" falhou assim uma vez logo depois de um npm ci. Alinhar os dois
  // carimbos também não serve, porque utimesSync arredonda na casa do
  // microssegundo e o comprimido acabava 0,05 ms à frente.
  //
  // Um .gz vindo do git chega com data nova e continua disparando a extração,
  // que é o comportamento certo.
  const marca = new Date(mtime(destino) + 1000);
  fs.utimesSync(origem, marca, marca);

  return { cru: fs.statSync(origem).size, comprimido: fs.statSync(destino).size };
}

/**
 * Descomprime o pool se ele estiver faltando ou desatualizado.
 *
 * Roda antes do build e do dev. É idempotente e sai na hora quando o arquivo
 * cru já está em dia, para não custar nada no caso comum.
 */
export async function unpackPool(): Promise<"extraido" | "em-dia" | "ausente"> {
  const destino = dbPath();
  const origem = packedPath();

  if (!fs.existsSync(origem)) {
    // Sem o comprimido, o cru pode existir por ter acabado de ser ingerido.
    return fs.existsSync(destino) ? "em-dia" : "ausente";
  }
  if (fs.existsSync(destino) && mtime(destino) >= mtime(origem)) return "em-dia";

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  await pipeline(
    fs.createReadStream(origem),
    zlib.createGunzip(),
    fs.createWriteStream(tmp),
  );
  fs.renameSync(tmp, destino);
  return "extraido";
}
