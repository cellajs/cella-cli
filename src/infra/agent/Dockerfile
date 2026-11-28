# check=skip=InvalidDefaultArgInFrom
# The agent: the infra-agent Compose service every machine runs. It boots the
# machine's release (the env file, the archives, compose up with the migrate
# companion), then answers the load balancer's health checks, restarts an app
# container that stops answering, and drains on its manifest's order. It
# ships as an archive of the release, which the launcher checks against its
# digest and loads at the first boot.
#
# It drives the HOST Docker daemon through the mounted socket
# (/var/run/docker.sock), so it needs the docker CLI + compose plugin; the
# launcher runs Compose from this image too. It runs on the host network and
# probes the private network via `ip route`, so it needs iproute2. The package
# build bundles the agent as entry.cjs beside this file, the build context
# (dist/infra-assets/agent). NODE_VERSION is the app's root package.json
# `engines.node`; without a default, so the `check=skip` line on top. The
# release bake passes NODE_IMAGE, the `node` image at that version by digest
# from lib/deploy/node-image.ts, which a Node bump refreshes.
ARG NODE_VERSION
ARG NODE_IMAGE=node:${NODE_VERSION}-bookworm-slim
FROM ${NODE_IMAGE}

# Docker's package signing key ships beside this file, with the fingerprint
# 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88. The build fetches no key:
# nothing it downloads decides which packages apt trusts.
COPY docker.asc /etc/apt/keyrings/docker.asc

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates iproute2 \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY entry.cjs /app/agent.cjs

ENTRYPOINT ["node", "/app/agent.cjs"]
