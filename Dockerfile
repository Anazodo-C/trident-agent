# Backend image for Railway.
#
# A Dockerfile rather than nixpacks.toml/railpack.json: Railway switched its
# default builder from Nixpacks to Railpack, which silently ignored the
# nixpacks config and failed on autodetection. Every builder defers to a
# Dockerfile, so this pins the build regardless of which one Railway uses.

FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries but falls back to compiling from
# source when none matches the platform; these are what node-gyp needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, so the dependency layer caches independently of source
# changes. All workspace manifests are needed for npm ci to match the lockfile.
COPY package.json package-lock.json ./
COPY apps/node-backend/package.json apps/node-backend/
COPY apps/frontend/package.json apps/frontend/

# Scoped to the backend workspace — the frontend's ~700 packages are skipped.
# NODE_ENV is deliberately still unset here so devDependencies (esbuild) install.
RUN npm ci --workspace @trident/node-backend --include-workspace-root

COPY . .

RUN npx esbuild apps/node-backend/src/server.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=apps/node-backend/dist/server.js

# Set only after the build, so it cannot strip devDependencies above.
ENV NODE_ENV=production

# Railway injects PORT; this is documentation, not a binding.
EXPOSE 3001

CMD ["node", "apps/node-backend/dist/server.js"]
