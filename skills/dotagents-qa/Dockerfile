FROM node:24-bookworm

ENV CI=1
ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=/pnpm:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    jq \
    less \
    openssh-client \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "$PNPM_HOME" "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare pnpm@10.28.2 --activate

RUN npm install -g --no-audit --no-fund \
    @anthropic-ai/claude-code@latest \
    @openai/codex@latest \
    @earendil-works/pi-coding-agent@latest \
    opencode-ai@latest \
  && claude --version \
  && codex --version \
  && pi --version \
  && opencode --version

WORKDIR /sandbox

CMD ["bash"]
