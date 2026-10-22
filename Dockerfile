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

# Serve stage with Bun
FROM oven/bun:latest

COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Install a simple HTTP server
RUN bun add serve

# Copy built assets from build stage
COPY --from=build /app/dist /app/dist

# Expose port
EXPOSE 3000

# Start the static file server
CMD ["bunx", "serve", "dist", "-s", "-p", "3000"]
