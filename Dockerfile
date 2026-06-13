FROM node:22-bookworm AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates build-essential pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add wasm32-unknown-unknown \
  && cargo install wasm-pack --version 0.13.1

COPY package.json package-lock.json ./
COPY shared-types/package.json shared-types/package.json
COPY web/package.json web/package.json
RUN npm ci --include=dev --workspaces

COPY shared-types ./shared-types
COPY wasm-engine ./wasm-engine
COPY web ./web
RUN npm run build \
  && test -f web/dist/index.html

FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
