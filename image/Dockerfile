# Cardinal runner images, driven by entrypoint.sh. Build context is this directory.
#
#   runner  (default)  Ubuntu 24.04 + actions/runner + Node 22              docker buildx build --platform linux/amd64 image/
#   android            runner + JDK 21 + Android SDK, for Gradle/AGP jobs   ... --target android image/
FROM ubuntu:24.04 AS runner

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

# ---------------------------------------------------------------------------------------------------------------------
# android: the runner image plus what an Android Gradle build needs, so a job can skip setup-java and SDK installs.
# Env for jobs comes from the runner's own .env/.path files (read by run.sh), since Sandbox doesn't apply Docker ENV.
FROM runner AS android

ARG CMDLINE_TOOLS=13114758
ARG ANDROID_PLATFORMS="platforms;android-37.0 platforms;android-36"
ARG ANDROID_BUILD_TOOLS="build-tools;36.1.0"

USER root
# Temurin JDK 21 (what actions/setup-java installs). fontconfig + a font: Robolectric/Roborazzi render text
# through AWT, which fails without any system font.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig libfreetype6 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/jdk-21 \
    && curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" \
       | tar -xz -C /opt/jdk-21 --strip-components=1 \
    && /opt/jdk-21/bin/java -version \
    && mkdir -p /opt/android-sdk && chown runner:runner /opt/android-sdk
USER runner

ENV JAVA_HOME=/opt/jdk-21 \
    PATH=/opt/jdk-21/bin:$PATH
ENV ANDROID_HOME=/opt/android-sdk
RUN curl -fsSL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" \
    && mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip \
    && sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
    && yes | "$sdkmanager" --licenses >/dev/null \
    && "$sdkmanager" --install "platform-tools" $ANDROID_PLATFORMS $ANDROID_BUILD_TOOLS >/dev/null \
    && rm -rf "$ANDROID_HOME/.temp" /home/runner/.android/cache

# The actions runner loads .env into every job's environment and prepends .path to PATH.
RUN printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\nJAVA_HOME=%s\nJAVA_HOME_21_X64=%s\n' \
         "$ANDROID_HOME" "$ANDROID_HOME" "$JAVA_HOME" "$JAVA_HOME" > /home/runner/.env \
    && printf '%s/cmdline-tools/latest/bin:%s/platform-tools:%s/bin:%s\n' \
         "$ANDROID_HOME" "$ANDROID_HOME" "$JAVA_HOME" "$PATH" > /home/runner/.path \
    && cat /home/runner/.env /home/runner/.path
