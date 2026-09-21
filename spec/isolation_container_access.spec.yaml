specs:
  - id: isolation_container_access_key-only-auth
    description: The container's sshd accepts only public key authentication as the agent user.
    motivation: Isolated agent containers are reached over SSH and must not be reachable by password.
    acceptance_criteria:
      - ssh agent@127.0.0.1 -p <port> with the herdr-container private key succeeds and provides a
        shell as agent.
      - Password and keyboard-interactive authentication are refused (sshd_config sets
        PasswordAuthentication no, KbdInteractiveAuthentication no, PermitRootLogin no, AllowUsers
        agent).
    status: done

  - id: isolation_container_access_key-ownership
    description: The host SSH public key is delivered into the container as a file owned by agent with mode 600.
    motivation: A bind mount preserves host ownership, and OpenSSH's safe_path rejects authorized_keys
      files with bad ownership or modes, so the key must be copied with agent ownership at startup.
    acceptance_criteria:
      - The public key is mounted read-only at /etc/ssh/authorized_keys.src.
      - On container startup, start-container copies it to /etc/ssh/authorized_keys/agent owned by
        agent:agent with mode 600.
      - SSH from the host with the matching private key succeeds.
    status: done
