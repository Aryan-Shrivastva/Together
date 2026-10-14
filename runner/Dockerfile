FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
ENV HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm \
    PIP_CACHE_DIR=/tmp/.pip \
    PATH=/workspace/node_modules/.bin:/tmp/.local/bin:${PATH}

CMD ["tail", "-f", "/dev/null"]
