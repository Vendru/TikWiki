/**
 * Comprime data/pool.db em data/pool.db.gz, que é o que vai versionado.
 * Rode depois de qualquer ingestão ou repontuação.
 */
import { packPool } from "../src/lib/db/pack";

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

packPool()
  .then(({ cru, comprimido }) => {
    console.log(`pool.db     ${mb(cru)}`);
    console.log(`pool.db.gz  ${mb(comprimido)}  (${(cru / comprimido).toFixed(2)}x)`);
    if (comprimido > 100e6) {
      console.error(
        `\nATENÇÃO: ${mb(comprimido)} passa do limite de 100 MB por arquivo do GitHub — o push será recusado.`,
      );
      process.exit(1);
    }
    if (comprimido > 50e6) {
      console.warn(`\nAviso: acima de 50 MB o GitHub reclama, mas aceita.`);
    }
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
