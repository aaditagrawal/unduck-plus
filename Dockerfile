FROM node:24.22.1-bookworm-slim AS node

# Build stage
FROM oven/bun:latest as build

COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy all files
COPY . .

# Build the app
RUN bun run build

# Serve stage needs only the Bun platform, with no registry packages.
FROM oven/bun:latest

WORKDIR /app

# Copy built assets from build stage
COPY --from=build /app/dist /app/dist
COPY scripts/server.mjs /app/scripts/server.mjs

# Expose port
EXPOSE 3000

# Start the static file server
CMD ["bun", "scripts/server.mjs", "dist"]
