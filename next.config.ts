import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Módulo nativo: não pode ser empacotado pelo bundler do servidor.
  serverExternalPackages: ["better-sqlite3"],
  // O Next escreve arquivos de instrução para ferramentas automáticas na raiz
  // a cada dev/build. Este repositório não os quer versionados.
  agentRules: false,
};

export default nextConfig;
