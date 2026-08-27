import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Módulo nativo: não pode ser empacotado pelo bundler do servidor.
  serverExternalPackages: ["better-sqlite3"],
  // Rastreia só o que o servidor usa em vez de levar o node_modules inteiro
  // para a imagem. Sem isto a imagem passa de 1,2 GB: 474 MB de dependências
  // (das quais 45 MB são o sharp, que este app não usa) e 358 MB de cache de
  // build dentro do .next.
  output: "standalone",
  // O rastreamento vê os caminhos montados em src/lib/config.ts e puxa
  // diretórios inteiros que só a pipeline usa: o cache das respostas cruas tem
  // 3,9 GB e ia junto. É a mesma causa do aviso de "overly broad patterns" no
  // build. O pool comprimido também não serve em produção — o build extrai o
  // .db, e é só ele que precisa viajar.
  outputFileTracingExcludes: {
    "*": ["./.cache/**", "./data/*.gz", "./scripts/**", "./tests/**"],
  },
  // O Next escreve arquivos de instrução para ferramentas automáticas na raiz
  // a cada dev/build. Este repositório não os quer versionados.
  agentRules: false,
};

export default nextConfig;
