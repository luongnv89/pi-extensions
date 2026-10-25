---
name: agent-qa
description: Run agent-qa web and mobile tests or review recorded evidence and memidex knowledge. Use for explicit agent-qa requests or projects with agent-qa.config.yaml. Skip unrelated testing and generic browser tasks.
license: MIT
effort: high
metadata:
  version: "1.0.0"
  author: vostride
---

# agent-qa

Use agent-qa from vostride for natural-language web and mobile testing with advanced memidex memory and self-improvement.

## When to Use

Treat `$ARGUMENTS` as the user's requested journey, test, run, or evidence question. Answer in their language.
Use `/skill:agent-qa` for existing agent-qa tests, recorded run evidence, or memidex knowledge.
Do not introduce agent-qa into unrelated testing work solely because this skill is installed.
Separate authoring, execution, and saved-run review; read-only review does not authorize a new run or a knowledge correction.

## Prerequisites

Locate the application's instructions and `agent-qa.config.yaml`; preserve the configured provider, target, test identity, and acceptance criteria.
Use the project's installed runtime and its help. The references were checked with agent-qa 0.2.3, which requires Node.js 24 or newer.
Pi invokes the CLI through its shell tools. This skill does not install agent-qa, configure credentials, register MCP tools, or start services.
Browser or Appium setup is needed for the corresponding platform's execution, not for reviewing saved evidence.

| Work | Read relative to this skill directory |
| --- | --- |
| Setup, authoring, validation, execution, optional MCP | [Project and runs](references/project-and-runs.md) |
| Verdicts, steps, artifacts, memory, corrections | [Evidence and memory](references/evidence-and-memory.md) |

## Execution Flow

1. Resolve the requested scope and existing project. Use `--config` explicitly when the shell's working directory is elsewhere.
2. Discover the installed contract with `agent-qa init --agent` and version-matched guidance with `agent-qa skills --json`. Discovery does not initialize the project.
3. For an existing test, use validation and `run --dry-run` to check preparation and selection. Run only the requested journey or suite when execution is in scope; retain its actual run identity and inspect the terminal outcome.
4. For authoring, use a supported, available authoring operation and inspect its write or refusal receipt. The host creates canonical test IDs; never invent one or reuse another test's ID. Connected `agent_qa_write_test` or `agent_qa_refine_test` tools are optional and must actually be available before calling them.
5. For recorded evidence, start with the requested run ID or `agent-qa runs list --json`. Match target, test identity, completion time, and build. Read `agent-qa digest RUN_ID --json` and relevant step evidence using returned IDs and zero-based indices.
6. For knowledge changes, first read the project's committed `agent-qa-knowledge/AGENTS.md`. Distinguish what a run consumed from what it learned. Preview and apply corrections only within the user's authorized task, retaining the actual receipt or refusal.

## Acceptance Criteria

- Report the target, test or suite, and actual run ID when available, with the recorded outcome and supporting step evidence.
- Distinguish preparation checks, executed behavior, and knowledge changes. Validation, a dry run, or a run acknowledgement does not prove application behavior.
- For authoring, identify the actual written artifact and verification disposition; a refused draft is not a created test.
- Preserve expected outcomes and prior failures. A learned record or corrected verdict does not establish that the application was rerun.
- Inspect logs and screenshots before sharing; only configured secret values receive masking. Use `{{secret:NAME}}` in test steps; recorded `[secret:NAME]` markers are not values to type.

## Edge Cases

- Authoring and verification can call models and execute tests. For a non-executing draft request, provide proposed intent without invoking these operations; explain that no formal test or run was created.
- If the needed authoring operation is unavailable, report that limitation and proposed intent. Do not invent a CLI command or assume optional MCP tools are connected.
- An empty completed-run list means matching completed evidence was not returned; it proves neither a pass nor that an asynchronous run is inactive. Do not start a duplicate run while its status is unknown.
- Treat reader errors, unavailable artifacts, and setup failures as limitations. Preserve recorded `healed`, `timeout`, or `cancelled` outcomes instead of relabeling them as passed.
- Use supported CLI readers or connected MCP tools. Never query or edit `.agent-qa/` databases, caches, or indexes directly.
