/**
 * Descomprime data/pool.db.gz. Roda automaticamente antes do build e do dev.
 */
import { unpackPool } from "../src/lib/db/pack";

unpackPool()
  .then((estado) => {
    if (estado === "extraido") console.log("pool.db extraído de pool.db.gz");
    else if (estado === "ausente") {
      console.error(
        "Nenhum pool encontrado. Rode a ingestão: npm run ingest:unusual",
      );
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
