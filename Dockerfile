FROM node:20-bookworm

ENV PORT=3000 \
    CLI_HOME=/opt/cli-tools \
    GO_VERSION=1.25.0 \
    PATH=/opt/cli-tools/go/bin:/opt/cli-tools/bin:/opt/cli-tools/.local/bin:/opt/cli-tools/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /srv/cli-runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git tar \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app \
    && mkdir -p /opt/cli-tools/bin \
    && mkdir -p /opt/cli-tools/.local/bin \
    && mkdir -p /opt/cli-tools/npm-global/bin \
    && mkdir -p /opt/cli-tools/npm-global/lib/node_modules \
    && mkdir -p /opt/cli-tools/npm-global/share

COPY server.mjs /srv/cli-runner/server.mjs

EXPOSE 3000

CMD ["node", "/srv/cli-runner/server.mjs"]
