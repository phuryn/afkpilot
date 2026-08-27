# A linked machine that is a container.
#
# SPIKE, not a product. This exists to answer one question neither repo had
# answered: does the real desktop host run with no display, on Linux, dial the
# relay on its own, and serve a browser? Every plan for managed cloud
# environments rests on that being yes, and the only prior evidence pointed the
# other way — the relay's CI ran `e2e:lifecycle` against this same app on
# ubuntu-latest four times in August 2026 and it failed four times, ending on
# Electron aborting because a runner's `chrome-sandbox` is not root-owned mode
# 4755 (.github/workflows/ci.yml documents the removal).
#
# So the sandbox is the first thing handled, and handled the way a container
# should: `--no-sandbox`. Chromium's setuid sandbox contains a renderer from the
# rest of a shared machine. This machine is one tenant's environment, created
# for them and destroyed with them, and the container is itself the boundary.
# Making chrome-sandbox root-owned setuid inside an image would be more work to
# end up somewhere weaker.
#
# BUILD CONTEXT IS THE EXTENSION REPO, not this one, and it is expected to be a
# `git archive` of a committed revision — see cloud/build.mjs. That is not a
# convenience: it means the image cannot contain an uncommitted local edit or a
# host's Windows node_modules, which is the whole reason to build from an
# archive rather than a working tree.
#
# NOT an optimised image and not pretending to be. It carries Chromium and a
# display server for an app that draws nothing, which the research already named
# as what a plain-Node `Host` would fix later (host.ts imports no `vscode`, so
# it is possible). That is an optimisation for when size and boot time matter.
# This is about whether the shape works at all.
FROM node:20-bookworm-slim

# Chromium's runtime libraries plus Xvfb. Electron links against these whether
# or not a window is shown: it brings up the GTK/X stack during startup, so a
# headless run needs the same set a visible one does. A missing one of these is
# not a warning — it is `error while loading shared libraries` and exit 127.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
      libatspi2.0-0 libdrm2 libgbm1 libxcb-dri3-0 libasound2 \
      libcups2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 libglib2.0-0 \
      git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before source, so editing a file does not re-download Electron.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run compile

# The agent CLIs, after the build so a CLI release does not invalidate it.
#
# `|| true` on each: a container must still boot and say "that agent is not
# installed" rather than fail to build. That is also a state a real environment
# can legitimately be in, and the client already renders it.
#
# All THREE, because a cloud environment has no desk to fall back to. On a
# laptop an agent that will not sign in headlessly can be connected by walking
# to the machine; here there is no machine to walk to, so whatever cannot be
# done from a phone cannot be done at all.
RUN curl -fsSL https://x.ai/cli/install.sh | bash || true
RUN curl -fsSL https://claude.ai/install.sh | bash || true
RUN npm install -g @openai/codex@latest || true

# A pseudo-terminal, and the reason it is worth a native dependency.
#
# `claude setup-token` is an Ink TUI: given pipes it prints ZERO BYTES and waits
# for a keypress that cannot arrive (measured — 18 s, both streams empty).
# `gh auth login` is the same shape. Neither can be driven by the pipe-based
# spawn the host uses everywhere else.
#
# The extension deliberately avoids native modules — keep-awake.ts chose three
# OS binaries over one native dependency for exactly that reason. That rule is
# about a VS Code extension shipped to thousands of machines, and it does not
# apply to an image we build and run ourselves. Here a pty is just a library.
RUN npm install -g node-pty || true

# Where a real environment mounts its volume. Everything that must outlive a
# stop lives here: the agent logins, and the projects themselves.
#   /data/.grok        GROK_HOME — the Grok CLI's cached OAuth token
#   /data/Grok Build             — projects created or cloned from a phone
ENV HOME=/data
ENV GROK_HOME=/data/.grok
ENV PATH="/data/.local/bin:/data/.grok/bin:/root/.local/bin:${PATH}"
RUN mkdir -p /data
VOLUME ["/data"]

COPY cloud-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
