/**
 * Sobe o build de produção.
 *
 * Existe porque `next start` não funciona com `output: "standalone"` — o
 * próprio Next avisa e manda usar `node .next/standalone/server.js`. Só que o
 * standalone não inclui `.next/static`, por design: o Next espera que quem
 * empacota copie os estáticos para dentro dele. No Dockerfile isso é um COPY;
 * aqui é este script.
 *
 * Uso: npm start
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const raiz = process.cwd();
const standalone = path.join(raiz, ".next", "standalone");
const servidor = path.join(standalone, "server.js");

if (!fs.existsSync(servidor)) {
  console.error(
    `Build de produção não encontrado em .next/standalone.\n` +
      `Rode antes:\n  npm run build`,
  );
  process.exit(1);
}

// Os estáticos são gerados fora do standalone e precisam ser espelhados para
// dentro dele. Copiar a cada partida é barato (612 KB) e evita servir o CSS e
// os chunks de um build anterior.
const origem = path.join(raiz, ".next", "static");
const destino = path.join(standalone, ".next", "static");
if (fs.existsSync(origem)) {
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.cpSync(origem, destino, { recursive: true });
}

// O public/ só existe se alguém adicionar arquivos estáticos ao projeto.
const publico = path.join(raiz, "public");
if (fs.existsSync(publico)) {
  fs.cpSync(publico, path.join(standalone, "public"), { recursive: true });
}

const filho = spawn(process.execPath, ["server.js"], {
  cwd: standalone,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});

filho.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
