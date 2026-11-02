# The Python sandbox image with Node added, for MCP servers that come from npm.
# Same user, same lockdown from the runner. Python stays because the runner's
# staging and inspection programs are Python; npm install runs with scripts off.
FROM node:24-slim AS node

FROM reality-sandbox-python:dev
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && node --version && npm --version
USER sandbox
