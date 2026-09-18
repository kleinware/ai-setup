FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG OPENCODE_VERSION=1.18.31
ARG LAZYGIT_VERSION=0.65.1

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

# Lazygit
RUN LAZYGIT_ARCH="$(uname -m | sed -e 's/aarch64/arm64/')" \
    && curl -fsLo lazygit.tar.gz \
       "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_${LAZYGIT_ARCH}.tar.gz" \
    && tar xf lazygit.tar.gz lazygit \
    && install -m 755 lazygit /usr/local/bin/lazygit \
    && rm lazygit lazygit.tar.gz

# Dedicated development user (UID/GID are matched to the host at startup)
# The config dirs must exist in the image so docker does not create
# the mount targets as root.
RUN userdel -r ubuntu \
    && useradd -m -s /bin/bash agent \
    && passwd -d agent \
    && mkdir -p /workspace /home/agent/.config/opencode /home/agent/.config/herdr \
    && chown -R agent:agent /home/agent/.config

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