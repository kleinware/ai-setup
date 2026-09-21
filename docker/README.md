# Setup

```
ssh-keygen -t ed25519 \
  -f ~/.ssh/herdr-container \
  -C "herdr-container"
```

# SSH Config

`dev-repo up` assigns the host ports automatically and adds the entry to
`~/.ssh/config` itself:

```
Host dev-my-project-2240
    HostName 127.0.0.1
    Port 2242
    User agent
    IdentityFile ~/.ssh/herdr-container
    IdentitiesOnly yes
```

# Config files

At container start, the startup script copies `container_opencode.json`,
`herdr_config.toml`, `agents/skills/`, `agents/agent-files/`, and `devtools/`
from the image's baked-in setup files (`/opt/setup-src`, copied from the repo
at build time) into the container: the config and agent files into the
agent's config dirs, and `devtools/` into `/home/agent/bin`, so host-side
edits or moving the repo do not affect running containers. Recreate the container to refresh them. The gitconfig is
still bind-mounted read-only to `/home/agent/.gitconfig`. The startup script
also prepends `/home/agent/bin` to PATH in `/home/agent/.bashrc` (adding the
line only once) and writes the container build timestamp to
`/home/agent/.container_version.txt` (for example `2026-12-04 18:43:17`).

# Web

Port 8080 inside the container is published on the host as the SSH port + 6
(e.g. SSH port 2242 -> http://127.0.0.1:2248/), so agent-started web servers
can be driven with a browser from the host.

# Down

`dev-repo down` tears down the project's container and its volumes after a
yes/no confirmation. It first warns which container will be destroyed and
what will be lost: the opencode session information in the container, the SSH
host key (connection fingerprint) for the host, and any files in the container
outside /workspace. Files under /workspace stay on the host in the project
folder.

# Herdr

Nested herdr sessions are not allowed. `dev-repo up` registers the container
with herdr on the host automatically when herdr is installed (skipping the
add if the machine is already registered). When herdr is not installed, it
prints the command to run:

```
herdr machine add dev-project-a --label "project-a"
```