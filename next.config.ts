import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Módulo nativo: não pode ser empacotado pelo bundler do servidor.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
