# Software Factory — Agent Instructions

## Project

An autonomous software generation platform built with TypeScript (strict), Fastify, PostgreSQL 16 with RLS, and Docker Compose.

## Context for Agents

- **AGENTS.md** at the project root — read for project structure and conventions
- **ROADMAP.md** — current milestone and task list
- Project directory: `/root/projects/software-factory`

## Available MCP Tools (Code Intelligence)

This project has three MCP servers available:

1. **codebase-memory-mcp** — pre-built knowledge graph of the codebase. Tools: `get_architecture`, `search_code`, `get_code_snippet`, `query_graph`.
2. **context7** — library API docs (React, TypeScript, etc.)
3. **playwright** — browser/UI testing

The codebase index is auto-updated on every commit. No manual setup needed.

## Quality Gate

```bash
npm run typecheck && npm test
```

## Commit Convention

`feat(phase): Title` — conventional commits. Orchestrator handles commits and pushes; leave those to it.