specs:
  - id: isolation_script_output_ls-running-projects
    description: The ls command lists all currently running AI project containers.
    motivation: Users need to see which agent containers are running and their status without digging
      through docker ps.
    acceptance_criteria:
      - Running ./ai-repo.sh ls prints a header line (PROJECT, PORT, STATUS) followed by one line
        per running ai-* compose container with its project name, host SSH port, and status.
      - Compose projects whose name does not start with ai- are not listed.
      - When no AI project containers are running, the command prints 'No running AI project
        containers.'
    status: done

  - id: isolation_script_output_next-steps
    description: On success, the up command prints the SSH config block for the project and the herdr
      machine add command.
    motivation: Users need the exact host alias and herdr registration to use the container; nested
      herdr sessions are not allowed, so the host herdr must register the container.
    acceptance_criteria:
      - The output includes a Host ai-<project> block with HostName 127.0.0.1, Port <ssh-port>, User
        agent, IdentityFile <key>, and IdentitiesOnly yes.
      - The output includes herdr machine add ai-<project> --label "<project>".
    status: done

  - id: isolation_script_output_web-port
    description: On success, the up command prints the web base URL for the container's port 8080.
    motivation: Users need the exact URL to open the container's web server in a browser and verify site
      behavior.
    acceptance_criteria:
      - The output includes http://127.0.0.1:<web-port>/ where <web-port> is the SSH port + 1.
    status: done
