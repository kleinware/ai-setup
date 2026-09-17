FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG OPENCODE_VERSION=1.18.31

# Base development dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    openssh-server \
    python3 \
    python3-pip \
    build-essential \
    sudo \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# OpenCode
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# Dedicated development user
RUN useradd -m -s /bin/bash agent \
    && passwd -d agent \
    && mkdir -p /workspace \
    && chown agent:agent /workspace

# Install Herdr using its official installer
RUN su - agent -c \
    'curl -fsSL https://herdr.dev/install.sh | sh' \
    && install -m 755 \
       /home/agent/.local/bin/herdr \
       /usr/local/bin/herdr

# Configure SSH for key-only access
RUN mkdir -p /run/sshd /var/lib/herdr-ssh \
    /etc/ssh/authorized_keys \
    && printf '%s\n' \
       'Port 2222' \
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

WORKDIR /workspace

EXPOSE 2222

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start-container"]