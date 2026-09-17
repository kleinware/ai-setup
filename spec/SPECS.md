specs:
- id: isolation_container_access_key-only-auth
  description: The container's sshd accepts only public key authentication as the agent user.
  motivation: Isolated agent containers are reached over SSH and must not be reachable by password.
  acceptance_criteria:
  - ssh agent@127.0.0.1 -p <port> with the herdr-container private key succeeds and provides a shell as
    agent.
  - Password and keyboard-interactive authentication are refused (sshd_config sets PasswordAuthentication
    no, KbdInteractiveAuthentication no, PermitRootLogin no, AllowUsers agent).
- id: isolation_container_access_key-ownership
  description: The host SSH public key is delivered into the container as a file owned by agent with mode
    600.
  motivation: A bind mount preserves host ownership, and OpenSSH's safe_path rejects authorized_keys files
    with bad ownership or modes, so the key must be copied with agent ownership at startup.
  acceptance_criteria:
  - The public key is mounted read-only at /etc/ssh/authorized_keys.src.
  - On container startup, start-container copies it to /etc/ssh/authorized_keys/agent owned by agent:agent
    with mode 600.
  - SSH from the host with the matching private key succeeds.
- id: isolation_container_persistence_survives-recreate
  description: The agent workspace, home directory, and SSH host key survive container recreation.
  motivation: Rebuilding or recreating a container must not lose work or change the SSH host key that
    clients have already trusted.
  acceptance_criteria:
  - Files under /workspace and /home/agent persist across docker compose up -d --build of the same project.
  - The SSH host key in /var/lib/herdr-ssh is preserved, so the client known_hosts entry for the project
    remains valid after recreation.
- id: isolation_script_output_next-steps
  description: On success, ai-repo.sh prints the SSH config block for the project and the herdr machine
    add command.
  motivation: Users need the exact host alias and herdr registration to use the container; nested herdr
    sessions are not allowed, so the host herdr must register the container.
  acceptance_criteria:
  - The output includes a Host ai-<project> block with HostName 127.0.0.1, Port <ssh-port>, User agent,
    IdentityFile <key>, and IdentitiesOnly yes.
  - The output includes herdr machine add ai-<project> --label "<project>".
- id: isolation_script_setup_requires-ssh-key
  description: ai-repo.sh exits with an error if the SSH public key file does not exist.
  motivation: The container accepts only that public key, so starting a container without the key would
    make it unreachable.
  acceptance_criteria:
  - With no ~/.ssh/herdr-container.pub and no SSH_PUBLIC_KEY override, ./ai-repo.sh test-proj 2221 exits
    non-zero and prints 'SSH public key not found'.
  - SSH_PUBLIC_KEY=/path/to/key.pub overrides the default key path.
- id: isolation_script_setup_validates-args
  description: ai-repo.sh validates the project name and SSH port before running docker compose.
  motivation: Compose project names must be safe identifiers, and binding invalid or privileged ports
    would fail or be unsafe.
  acceptance_criteria:
  - A project name not matching ^[a-z0-9][a-z0-9_-]*$ exits non-zero with 'Invalid project name'.
  - A port outside 1024-65535 exits non-zero with 'SSH port must be between 1024 and 65535'.
  - Any argument count other than two prints usage and exits non-zero.
- id: tooling_spec-manager_specs_agent-output-yaml
  description: Structured output the skill returns to the agent is YAML.
  motivation: YAML is more token-efficient than JSON for agent-consumed output, matching the YAML-on-disk
    spec format.
  acceptance_criteria:
  - find --query returns matching specs as a YAML list of id and description mappings.
  - read --id returns the spec as YAML.
- id: tooling_spec-manager_specs_create-update
  description: The spec-manager skill can create, update, read, and search canonical spec entries stored
    as YAML in spec/SPECS.md.
  motivation: Keep intended behavior a durable, version-controlled artifact that agents can discover and
    manage without external trackers.
  acceptance_criteria:
  - read --id returns the full spec for a known id and fails with not-found otherwise.
  - write --id with all fields as CLI arguments validates the four-field schema and the AGENTS.md taxonomy
    before creating or updating spec/SPECS.md and keeps the file sorted by id.
  - find --query prints matching specs as a YAML list of id and description.
- id: tooling_spec-manager_specs_sorted-by-id
  description: Entries in spec/SPECS.md are stored sorted alphabetically by id.
  motivation: Makes it easier for a human to find a spec's id and keeps specs in the same area/component/section
    grouped together.
  acceptance_criteria:
  - After every write, the specs list in spec/SPECS.md is ordered alphabetically by id.
  - Specs sharing the same area, component, and section appear contiguously.
