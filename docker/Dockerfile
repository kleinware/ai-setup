FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG OPENCODE_VERSION=1.18.31
ARG LAZYGIT_VERSION=0.65.1
ARG BUN_VERSION=1.4.2
ARG PLAYWRIGHT_VERSION=1.63.0
ARG GLOW_VERSION=3.0.0

# Base development dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    fd-find \
    file \
    git \
    htop \
    iproute2 \
    iputils-ping \
    jq \
    less \
    lsof \
    micro \
    nano \
    netcat-openbsd \
    openssh-client \
    openssh-server \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    shellcheck \
    sqlite3 \
    strace \
    sudo \
    tini \
    tmux \
    tree \
    unzip \
    vim \
    wget \
    zip \
    zstd \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# OpenCode
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# Lazygit
RUN LAZYGIT_ARCH="$(uname -m | sed -e 's/aarch64/arm64/')" \
    && curl -fsLo lazygit.tar.gz \
       "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_${LAZYGIT_ARCH}.tar.gz" \
    && tar xf lazygit.tar.gz lazygit \
    && install -m 755 lazygit /usr/local/bin/lazygit \
    && rm lazygit lazygit.tar.gz

# Glow
RUN GLOW_ARCH="$(uname -m | sed -e 's/aarch64/arm64/')" \
    && curl -fsLo glow.tar.gz \
       "https://github.com/charmbracelet/glow/releases/download/v${GLOW_VERSION}/glow_${GLOW_VERSION}_Linux_${GLOW_ARCH}.tar.gz" \
    && tar xf glow.tar.gz \
    && install -m 755 "glow_${GLOW_VERSION}_Linux_${GLOW_ARCH}/glow" /usr/local/bin/glow \
    && rm -rf glow.tar.gz "glow_${GLOW_VERSION}_Linux_${GLOW_ARCH}"

# Bun
RUN BUN_ARCH="$(uname -m | sed -e 's/x86_64/x64/')" \
    && curl -fsLo bun.zip \
       "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    && unzip -o bun.zip \
    && install -m 755 "bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && rm -rf bun.zip "bun-linux-${BUN_ARCH}"

# Dedicated development user (UID/GID are matched to the host at startup)
# The config dirs must exist in the image so docker does not create
# the mount targets as root.
RUN userdel -r ubuntu \
    && useradd -m -s /bin/bash agent \
    && passwd -d agent \
    && mkdir -p /workspace /home/agent/bin /home/agent/.config/opencode/agents /home/agent/.config/herdr \
    && chown -R agent:agent /home/agent/.config

# Install Herdr using its official installer
RUN su - agent -c \
    'curl -fsSL https://herdr.dev/install.sh | sh' \
    && install -m 755 \
       /home/agent/.local/bin/herdr \
       /usr/local/bin/herdr

# Playwright (headless Chromium for agent-driven browser tests)
# Browsers live outside /home/agent so the agent-home named volume
# cannot shadow them from the image.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
    && mkdir -p /opt/ms-playwright \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
        playwright install --with-deps chromium \
    && chown -R agent:agent /opt/ms-playwright

# Bake the repo's setup files into the image so the start script can copy
# them without bind-mounting them from the host repo.
COPY docker/container_opencode.json /opt/setup-src/docker/container_opencode.json
COPY docker/container_herdr_config.toml /opt/setup-src/docker/container_herdr_config.toml
COPY agents/skills /opt/setup-src/agents/skills
COPY agents/agent-files /opt/setup-src/agents/agent-files
COPY devtools /opt/setup-src/devtools

# Configure SSH for key-only access
RUN mkdir -p /run/sshd /var/lib/herdr-ssh \
    /etc/ssh/authorized_keys \
    && printf '%s\n' \
       'HostKey /var/lib/herdr-ssh/ssh_host_ed25519_key' \
       'PasswordAuthentication no' \
       'KbdInteractiveAuthentication no' \
       'PermitRootLogin no' \
       'AllowUsers agent' \
       'AuthorizedKeysFile /etc/ssh/authorized_keys/%u' \
       'UsePAM no' \
       'X11Forwarding no' \
       'PrintMotd no' \
       > /etc/ssh/sshd_config

# Initialize persistent SSH host key and start SSH
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    '# Match the container user/group to the host user/group.' \
    'if [ "$(id -u agent)" != "$HOST_UID" ]; then' \
    '    HOLDER="$(getent passwd "$HOST_UID" | cut -d: -f1)"' \
    '    [ -n "$HOLDER" ] && [ "$HOLDER" != agent ] && userdel "$HOLDER"' \
    '    usermod -u "$HOST_UID" agent' \
    'fi' \
    'if [ "$(id -g agent)" != "$HOST_GID" ]; then' \
    '    HOLDER="$(getent group "$HOST_GID" | cut -d: -f1)"' \
    '    [ -n "$HOLDER" ] && [ "$HOLDER" != agent ] && groupdel "$HOLDER"' \
    '    groupmod -g "$HOST_GID" agent' \
    'fi' \
    'chown agent:agent /home/agent' \
    'chown agent:agent /home/agent/.config /home/agent/.config/opencode /home/agent/.config/herdr' \
    'SETUP=/opt/setup-src' \
    'for path in docker/container_opencode.json docker/container_herdr_config.toml agents/skills agents/agent-files devtools; do' \
    '    [ -e "$SETUP/$path" ] || { echo "missing $SETUP/$path" >&2; exit 1; }' \
    'done' \
    'install -m 644 "$SETUP/docker/container_opencode.json" /home/agent/.config/opencode/opencode.json' \
    'install -m 644 "$SETUP/docker/container_herdr_config.toml" /home/agent/.config/herdr/config.toml' \
    'rsync -a --delete "$SETUP/agents/skills/" /home/agent/.config/opencode/skills/' \
    'rsync -a --delete "$SETUP/agents/agent-files/" /home/agent/.config/opencode/agents/' \
    'rsync -a --delete "$SETUP/devtools/" /home/agent/bin/' \
    'chown -R agent:agent /home/agent/.config/opencode /home/agent/.config/herdr /home/agent/bin' \
    'if ! grep -qF "export PATH=\"/home/agent/bin:\$PATH\"" /home/agent/.bashrc 2>/dev/null; then' \
    '    echo "export PATH=\"/home/agent/bin:\$PATH\"" >> /home/agent/.bashrc' \
    'fi' \
    'if ! grep -qF "cd /workspace/main" /home/agent/.bashrc 2>/dev/null; then' \
    '    echo "cd /workspace/main" >> /home/agent/.bashrc' \
    'fi' \
    'date "+%Y-%m-%d %H:%M:%S" > /home/agent/.container_version.txt' \
    'chown agent:agent /home/agent/.container_version.txt' \
    'KEY=/var/lib/herdr-ssh/ssh_host_ed25519_key' \
    'if [ ! -f "$KEY" ]; then' \
    '    ssh-keygen -q -t ed25519 -N "" -f "$KEY"' \
    'fi' \
    'install -m 600 /etc/ssh/authorized_keys.src /etc/ssh/authorized_keys/agent' \
    'chown agent:agent /etc/ssh/authorized_keys/agent' \
    'exec /usr/sbin/sshd -D -e' \
    > /usr/local/bin/start-container \
    && chmod +x /usr/local/bin/start-container

ENV HOME=/home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
ENV NODE_PATH=/usr/lib/node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

WORKDIR /workspace

EXPOSE 22 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start-container"]