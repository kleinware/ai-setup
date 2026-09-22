import path from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"

// The site lives next to another bun project (the spec-manager CLI); pin the
// Turbopack root to this directory so the site's own lockfile is used.
const root = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  turbopack: {
    root,
  },
}

export default nextConfig
