---
name: board
description: Run the next pipeline step for a {{VOCAB_ISSUE}}. Usage: /board <issue_number> [step]
user_invocable: true
argument-hint: "<issue_number> [step: refine|spec|code|test|context|pr|all] [no-worktree]"
---

# Board Pipeline Runner

Run the board automation pipeline locally for issue **#$ARGUMENTS**.

Spawn the `board-runner` agent with this task. Pass the full argument string so the agent knows the issue number and optional step.

## Instructions

Use the Agent tool to launch the `board-runner` agent with the following prompt:

> Process issue $ARGUMENTS through the board pipeline. If only an issue number is given, auto-detect the current board status and run the next step. If a step name is given (refine, spec, code, test, context, pr, all), run that specific step or run all remaining steps if "all". All steps run in isolated git worktrees by default (parallel-safe). Only disable worktrees if "no-worktree" is specified.

The board-runner agent handles everything: querying the board, moving cards, invoking the right sub-agent in a worktree, and advancing on completion.

Report back the result to the user when the agent completes.

## Worktree Mode (Default)

**Worktrees are always on by default.** Every sub-agent runs in an isolated git worktree — a temporary copy of the repo with the feature branch checked out. This means:

- You can run `/board 30 code` and `/board 42 spec` in two different terminals simultaneously
- Neither agent touches the other's working directory
- Sub-agents push to remote branches so changes survive worktree cleanup

To disable worktrees (e.g., for debugging), pass `no-worktree`:
- `/board 30 code no-worktree` — runs in the current working directory instead
