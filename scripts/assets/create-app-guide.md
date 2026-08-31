# Create your Code Review GitHub App

1. Open: \***\*CREATE_URL\*\***

2. Fill in the basics:
   - **GitHub App name:** `nibble-review` (the slug must match the `REVIEW_COMMAND` default, so reviews post as `nibble-review[bot]`)
   - **Homepage URL:** your repo or org URL
   - **Webhook → Active:** **unchecked** (the workflow is event-driven; the App does not need its own webhook listener)

3. Under **Repository permissions**, grant EXACTLY:
   - Contents: **Read-only**
   - Issues: **Read and write**
   - Pull requests: **Read and write**
   - Metadata: **Read-only** (selected automatically)

   Do **not** grant Administration or any "write" to Contents.

4. Under **Subscribe to events**, check:
   - Pull request
   - Issue comment

5. Under **Where can this GitHub App be installed**:
   - "Only on this account" for personal use, or
   - "Any account" if other orgs/repos will install it.

6. Click **Create GitHub App**.

7. After creation, on the App's **General** settings page:
   - Copy the **App ID** (numeric) and the **Client ID** (starts with `Iv`).
   - Scroll to **Private keys → Generate a private key**. A `*.pem` file downloads — keep it safe.

8. **Install the App:**
   - On the App page click **Install App** and install it on the repos/org you want reviewed. For an org, choose "Selected repositories" and pick the repos, or "All repositories".

Then configure a repository:

```bash
scripts/setup-review-bot.sh configure --repo OWNER/REPO \
  --app-client-id <Client ID> --private-key /path/to/private-key.pem \
  --opencode-key <OpenCode API key> \
  --command @your-bot --agent-repo owner/code-review-agent
```

Use `scripts/setup-review-bot.sh configure --help` for all options, and `scripts/setup-review-bot.sh check --repo OWNER/REPO` to verify.
