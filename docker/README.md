# Setup

```
ssh-keygen -t ed25519 \
  -f ~/.ssh/herdr-container \
  -C "herdr-container"
```

# SSH Config

`dev-repo up` assigns the host ports automatically and adds the entry to
`~/.ssh/config` itself. It also adds the container's host key to
`~/.ssh/known_hosts`, so non-interactive ssh (herdr) connects without a
host key prompt. With `--no-add-ssh-config` it prints the entry instead of
writing it:

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
`container_herdr_config.toml`, `agents/skills/`, `agents/agent-files/`, and `devtools/`
from the image's baked-in setup files (`/opt/setup-src`, copied from the repo
at build time) into the container: the config and agent files into the
agent's config dirs, and `devtools/` into `/home/agent/bin`, so host-side
edits or moving the repo do not affect running containers. Recreate the container to refresh them. The gitconfig is
still bind-mounted read-only to `/home/agent/.gitconfig`. The startup script
also prepends `/home/agent/bin` to PATH in `/home/agent/.bashrc` (adding the
line only once) and appends `cd /workspace/main` to `/home/agent/.bashrc`
(adding the line only once), so interactive shells — including ssh sessions —
start in `/workspace/main`. It also writes the container build timestamp to
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

With `--force` it skips the confirmation and tears down unconditionally, so
it can be used in scripts: `dev-repo down --force`.

# UAT

`docker/dev-repo-uat.sh` runs an end-to-end test of the full container
lifecycle on a throwaway project in `/tmp/dev-repo-test-<timestamp>/main`
(empty git repo): `dev-repo up`, verify the container / herdr machine / ssh /
opencode inference, `dev-repo up` again with a stale host key seeded
(verifying the key is replaced and the container version is newer),
`dev-repo down --force`, and verify the container and its volumes are gone.
It takes no arguments and is silent by default: on success it prints
`all tests (N/N) pass`, and on failure it prints which test failed, its
command, and its output. It requires the model server (`models/serve.sh`)
to be running and cleans up its host-side artifacts (herdr machine, ssh
config entry, known_hosts entry, `/tmp` dir) on exit, success or failure.

# Herdr

Nested herdr sessions are not allowed. `dev-repo up` registers the container
with herdr on the host automatically when herdr is installed (skipping the
add if the machine is already registered). When herdr is not installed, it
prints the command to run. With `--no-add-herdr-machine` it neither queries
nor registers herdr and always prints the command to run:

```
herdr machine add dev-project-a --label "project-a"
```