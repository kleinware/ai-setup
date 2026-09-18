specs:
  - id: isolation_container_persistence_project-folder-workspace
    description: The project folder containing 'main' and 'worktrees' is bind-mounted into the container
      as /workspace.
    motivation: The agent works directly on the project's files, and opencode worktrees created under
      /workspace/worktrees land in the host's <project>/worktrees directory.
    acceptance_criteria:
      - docker compose binds the parent of the 'main' folder to /workspace.
      - Inside the container, /workspace contains the main and worktrees folders.
    status: done

  - id: isolation_container_persistence_survives-recreate
    description: The agent workspace, home directory, and SSH host key survive container recreation.
    motivation: Rebuilding or recreating a container must not lose work or change the SSH host key that
      clients have already trusted.
    acceptance_criteria:
      - Files under /workspace and /home/agent persist across docker compose up -d --build of the
        same project.
      - The SSH host key in /var/lib/herdr-ssh is preserved, so the client known_hosts entry for the
        project remains valid after recreation.
    status: done
