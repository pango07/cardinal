# Cardinal runner image: Ubuntu 24.04 + actions/runner, driven by entrypoint.sh.
# Build context is this directory:  docker buildx build --platform linux/amd64 image/
FROM ubuntu:24.04

ARG RUNNER_VERSION=latest
# ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT is deliberately off: it dumps the runner's full trace log
# (hundreds of lines per job) into the sandbox output. "Listening for Jobs" / "Running job" still print.
ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_MANUALLY_TRAP_SIG=1

# actions/runner runtime deps (.NET needs ICU, OpenSSL, Kerberos, zlib, lttng),
# plus the tools nearly every job reaches for. 24.04 renamed a few libs to *t64.
# libnss-myhostname: Sandbox bind-mounts a read-only /etc/hosts without the VM's hostname, so every
# `sudo` would warn "unable to resolve host". nss-myhostname resolves it without touching /etc/hosts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip zip tar gzip xz-utils \
      libicu74 libssl3t64 libkrb5-3 zlib1g liblttng-ust1t64 \
      sudo libnss-myhostname \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^hosts:.*/hosts:          files myhostname dns/' /etc/nsswitch.conf

# Node 22 on PATH. The runner bundles its own node for JS actions, but job steps often call `node`/`npm`.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man

# ubuntu:24.04 ships a uid-1000 `ubuntu` user; remove it so `runner` gets uid 1000 like GitHub-hosted runners.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash runner \
    && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

USER runner
WORKDIR /home/runner

COPY --chown=runner:runner install-runner.sh /tmp/install-runner.sh
RUN bash /tmp/install-runner.sh "${RUNNER_VERSION}" && rm /tmp/install-runner.sh

COPY --chown=runner:runner --chmod=0755 entrypoint.sh /home/runner/entrypoint.sh

# Vercel Sandbox ignores ENTRYPOINT/CMD; the dispatcher runs entrypoint.sh via runCommand.
# Kept here so `docker run` behaves the same way for local testing.
CMD ["/home/runner/entrypoint.sh"]
