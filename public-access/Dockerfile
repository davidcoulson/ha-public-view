# Built by the Supervisor on the Home Assistant host (build.yaml picks the base image),
# and by `docker compose` for development (the default below).
ARG BUILD_FROM=node:26-alpine
FROM ${BUILD_FROM}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY dev ./dev
ENV DATA_DIR=/data PORT=8099 UI_PORT=8100
EXPOSE 8099 8100
# Runs as root like other add-ons: /data is a host directory owned by root.
CMD ["node", "src/main.ts"]
