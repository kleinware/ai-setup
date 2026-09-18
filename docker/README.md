# Setup

```
ssh-keygen -t ed25519 \
  -f ~/.ssh/herdr-container \
  -C "herdr-container"
```

# SSH Config

```
Host ai-project-a
    HostName 127.0.0.1
    Port 2201
    User agent
    IdentityFile ~/.ssh/herdr-container
    IdentitiesOnly yes

Host ai-project-b
    HostName 127.0.0.1
    Port 2202
    User agent
    IdentityFile ~/.ssh/herdr-container
    IdentitiesOnly yes
```

# Web

Port 8080 inside the container is published on the host as the SSH port + 1
(e.g. SSH port 2222 -> http://127.0.0.1:2223/), so agent-started web servers
can be driven with a browser from the host.

# Herdr

Nested herdr sessions are not allowed, so register each container with herdr on the host:

```
herdr machine add ai-project-a --label "project-a"
```