ARG BASE_IMAGE=wearesingular/aml-agent-sandbox:0.5.2-opencode
FROM ${BASE_IMAGE} AS review-build

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /tmp/nibble-review-build
COPY package.json package-lock.json tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
# The image build has no Git metadata, so installing repository hooks would be
# both noisy and ineffective. Dependency lifecycle scripts remain enabled.
RUN HUSKY=0 npm ci --include=dev \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /opt/nibble-review \
    && cp -R dist node_modules package.json /opt/nibble-review/ \
    && chmod +x \
      /opt/nibble-review/dist/cli/review.js \
      /opt/nibble-review/dist/cli/preflight.js

FROM ${BASE_IMAGE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG CONTEXT7_MCP_VERSION=3.2.4
ARG SKILLS_CLI_VERSION=1.5.23
ARG SINGULAR_SKILLS_REF=5be9e96f7423205fa9a01d7e448b69e2a3704ab5

RUN npm install -g @upstash/context7-mcp@${CONTEXT7_MCP_VERSION} \
    && rm -rf /root/.npm

RUN mkdir -p /usr/local/lib/nibble-review

USER aml
# Architecture skills are optional OpenCode capabilities. Pinning both source
# and installer keeps their review policy reproducible across image rebuilds.
RUN git init -q /tmp/singular-skills \
    && git -C /tmp/singular-skills fetch -q --depth=1 \
      https://github.com/we-are-singular/skills.git ${SINGULAR_SKILLS_REF} \
    && git -C /tmp/singular-skills checkout -q FETCH_HEAD \
    && NPM_CONFIG_CACHE=/tmp/skills-npm-cache npx --yes skills@${SKILLS_CLI_VERSION} add \
      /tmp/singular-skills \
      --global \
      --agent opencode \
      --skill backend-architecture frontend-architecture \
      --copy \
      --yes \
    && rm -rf /tmp/singular-skills /tmp/skills-npm-cache

USER root

COPY --from=review-build /opt/nibble-review/ /usr/local/lib/nibble-review/

COPY bin/provision.sh /usr/local/bin/provision.sh

RUN ln -sf /usr/local/lib/nibble-review/dist/cli/review.js /usr/local/bin/review_runner \
    && ln -sf /usr/local/lib/nibble-review/dist/cli/preflight.js /usr/local/bin/review_preflight

RUN chmod +x /usr/local/bin/provision.sh

ENV OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

WORKDIR /workspace
USER aml
CMD ["/bin/bash"]
