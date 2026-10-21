FROM oven/bun:1.4.2-slim AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
# Runs @ampcode/cli's trusted postinstall, which links the native amp binary.
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --compile --minify --outfile novarum-amp

# glibc + CA certs and nothing else; both the bot and the Amp CLI are self-contained binaries.
FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=build /app/novarum-amp /usr/local/bin/novarum-amp
COPY --from=build /app/node_modules/@ampcode/cli-linux-x64/amp /usr/local/bin/amp

ENV AMP_CLI_PATH=/usr/local/bin/amp \
    DATA_DIR=/data
# Pre-created so the named volume inherits nonroot ownership.
COPY --from=build --chown=nonroot:nonroot /tmp /data
VOLUME /data

ENTRYPOINT ["/usr/local/bin/novarum-amp"]
