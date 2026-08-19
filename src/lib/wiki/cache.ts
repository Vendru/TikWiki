import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cacheDir } from "../config";

/**
 * Cache em disco das respostas cruas da API. Reexecutar a pipeline não deve
 * refazer a rede toda — o custo de uma varredura ampla está quase todo aqui.
 */
export class DiskCache {
  constructor(private readonly dir: string = cacheDir()) {}

  private pathFor(key: string): string {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    // Dois níveis de subdiretório para não estourar o limite de arquivos por pasta.
    return path.join(this.dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`);
  }

  get<T>(key: string): T | undefined {
    const file = this.pathFor(key);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      // Entrada corrompida (escrita interrompida): trata como ausente.
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    const file = this.pathFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Escrita atômica: um Ctrl-C no meio não deixa JSON pela metade no cache.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }
}
