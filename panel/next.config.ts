import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El panel es privado: no lo queremos indexado ni cacheado por buscadores.
  async headers() {
    return [{
      source: "/:path*",
      headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
    }];
  },
};

export default nextConfig;
