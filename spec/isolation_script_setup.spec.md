specs:
  - id: isolation_script_setup_derives-project
    description: ai-repo.sh up derives the project name from the working directory and creates the
      worktrees directory.
    motivation: Each project is laid out as <project>/main plus <project>/worktrees, so the script can
      derive the project from the layout instead of taking it as an argument.
    acceptance_criteria:
      - When run from the git root named 'main', up uses the parent folder's name as the compose
        project name.
      - up creates <project>/worktrees next to main if it does not already exist.
    status: done

  - id: isolation_script_setup_requires-ssh-key
    description: ai-repo.sh up exits with an error if the SSH public key file does not exist.
    motivation: The container accepts only that public key, so starting a container without the key
      would make it unreachable.
    acceptance_criteria:
      - With no ~/.ssh/herdr-container.pub and no SSH_PUBLIC_KEY override, running up from the
        project's 'main' git root exits non-zero and prints 'SSH public key not found'.
      - SSH_PUBLIC_KEY=/path/to/key.pub overrides the default key path.
    status: done

  - id: isolation_script_setup_validates-args
    description: ai-repo.sh up validates its argument and working directory before running docker compose.
    motivation: The compose project name is derived from the folder layout and must be a safe
      identifier, the host SSH port must be a valid user port, and the script only works when
      invoked from the correct location.
    acceptance_criteria:
      - The up command requires exactly one argument (SSH port); any other count prints usage and
        exits non-zero.
      - A working directory not named 'main' exits non-zero with 'Must be run from a folder named
        'main'.
      - A working directory that is not the git root of a worktree exits non-zero.
      - A derived project name not matching ^[a-z0-9][a-z0-9_-]*$ exits non-zero with 'Invalid
        project name'.
      - A port outside 1024-65534 exits non-zero with 'SSH port must be between 1024 and 65534'. The
        web port is the SSH port + 1, so it must fit within 65535.
      - An unknown command prints usage and exits non-zero.
    status: done
