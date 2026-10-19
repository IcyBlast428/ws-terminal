ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends util-linux bash && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
ENV WS_TERMINAL_CONTAINER=1 WS_TERMINAL_HOST=0.0.0.0 WS_TERMINAL_PORT=8002 WS_TERMINAL_CWD=/root
EXPOSE 8002
STOPSIGNAL SIGTERM
CMD ["node", "server/src/index.js"]
