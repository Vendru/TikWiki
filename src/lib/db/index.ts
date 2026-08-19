import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "../config";

export type DB = Database.Database;

const SCHEMA = path.join(process.cwd(), "src", "lib", "db", "schema.sql");

/**
 * Abre o pool. `readonly` é o modo do app em produção — o arquivo é um
 * artefato de build, nunca escrito durante um request.
 */
export function openDb(opts: { readonly?: boolean; file?: string } = {}): DB {
  const file = opts.file ?? DB_PATH;

  if (opts.readonly) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `Pool não encontrado em ${file}. Rode a ingestão antes: npm run ingest:unusual`,
      );
    }
    return new Database(file, { readonly: true, fileMustExist: true });
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  return db;
}

/**
 * Fecha o pool deixando um único arquivo autocontido: sem WAL pendente e
 * compactado. É o que vai para o repo como artefato de build — os arquivos
 * -wal e -shm não são commitados, então o conteúdo precisa estar no .db.
 */
export function finalizeDb(db: DB): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.exec("VACUUM");
  db.close();
}
