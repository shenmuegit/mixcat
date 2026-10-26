# Issue tracker: GitHub

- Repository: [shenmuegit/mixcat](https://github.com/shenmuegit/mixcat).
- New features, changes to existing features, and confirmed bugs require a GitHub Issue before product-code changes. Their implementation branches are reviewed through Pull Requests targeting `main`.
- Follow the complete workflow and standing authorization in [AGENTS.md](../../AGENTS.md). Do not replace GitHub Issues with local Markdown tickets.
- Prefer the connected GitHub tools. If a required operation is unavailable, use an authenticated official `gh` CLI when available. Check the target repository before each mutation.
- Search existing issues before creating a duplicate. Read the full issue, comments and linked PRs before continuing it.
- Preserve the reporter's description and record current behavior, expected behavior, reproduction evidence, testable acceptance criteria and scope. Follow the installed triage skill's Agent Brief and disclosure requirements.
- A PR must reference its issue with `Closes #<number>` and follow the installed `pr` skill's Summary, Evidence and Merge Danger template.
- Check the current PR head, required checks and unresolved reviews before merging. Verify the merged commit and issue state afterwards.
- When using `gh` for multiline bodies or comments, save the exact text under this project's `.runtime/` and use `--body-file`. Never expose credentials, private captures or machine-specific local data in public text.

**PRs as a request surface: no.** External PRs are not automatically added to the triage queue; an explicitly requested PR can still be reviewed.

When a skill says “publish to the issue tracker”, create or update the corresponding GitHub Issue. When it says “fetch the relevant ticket”, read that Issue and its discussion.
